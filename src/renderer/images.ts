// Photos and screenshots you attach to a message, made ready for Claude in the browser.
//
// Large photos are scaled down to 1568 px on the long side, the most Claude uses without scaling
// them down itself. That keeps a 12-megapixel phone photo to a few hundred KB, which is quicker
// to send from a phone and costs fewer tokens.
//
// Claude accepts JPEG, PNG, GIF, and WebP. Anything else the browser can decode (HEIC on an
// iPhone, AVIF, BMP, TIFF in Safari) is redrawn as JPEG or PNG. HEIC the browser can't open goes
// through the heic-to WebAssembly decoder. GIFs are always redrawn as a still
// PNG, so an animated or oddly encoded GIF can't be rejected later.

import { MAX_IMAGE_BASE64, type ImageAttachment, type ImageMediaType } from '@shared/types'

const MAX_SIDE = 1568
/** Files at most this size (and MAX_SIDE) go as they are, so screenshots stay sharp PNGs. */
const PASS_THROUGH_BYTES = 2 * 1024 * 1024

/** File extensions treated as images even when the browser gives no MIME type (iOS sometimes doesn't). */
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i

export interface Attached extends ImageAttachment {
  /** For the thumbnail. */
  url: string
}

/** Whether a picked, pasted, or dropped file looks like an image worth trying. */
export function isImageFile(f: File): boolean {
  return f.type.startsWith('image/') || IMAGE_EXT.test(f.name) || (!f.type && !!f.size)
}

function describe(file: File): string {
  const name = file.name || 'This image'
  return file.type ? `${name} (${file.type})` : name
}

/** The real format, from the first bytes, so a mislabeled file isn't sent with the wrong type. */
async function sniff(file: Blob): Promise<ImageMediaType | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => reject(new Error('The image could not be read.'))
    r.readAsDataURL(blob)
  })
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('undecodable'))
    }
    img.src = url
  })
}

interface Decoded {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

/** Decodes with createImageBitmap (applies the photo's rotation), then falls back to <img>. */
async function decode(file: File): Promise<Decoded> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }
  } catch {
    // Some formats (HEIC in older Safari) decode only through <img>.
  }
  try {
    const img = await loadImage(file)
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} }
  } catch {
    // Fall through to the HEIC decoder.
  }
  if (await looksHeic(file)) {
    try {
      // About 3 MB of WebAssembly, loaded only the first time a browser can't open a HEIC photo
      // itself (Edge and the desktop app on Windows; iPhone Safari decodes HEIC natively).
      const { heicTo } = await import('heic-to/csp')
      const bmp = await heicTo({ blob: file, type: 'bitmap' })
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }
    } catch (err) {
      console.error('HEIC decode failed', err)
      throw new Error(`${describe(file)} is a HEIC photo that couldn't be decoded. Export it as JPEG and try again.`)
    }
  }
  throw new Error(`${describe(file)} isn't an image format this browser can open. Use JPEG, PNG, GIF, WebP, or HEIC.`)
}

/** HEIC and HEIF files are ISO media files: "ftyp" at byte 4, then a brand such as heic or mif1. */
async function looksHeic(file: Blob): Promise<boolean> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const ascii = String.fromCharCode(...b)
  return ascii.slice(4, 8) === 'ftyp' && /^(hei[cfsmx]|hev[cmsx]|mif[12]|msf1|avci)$/.test(ascii.slice(8, 12))
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The image could not be converted.'))), type, quality),
  )
}

/** Turns a picked, pasted, or dropped file into an image Claude accepts. */
export async function prepareImage(file: File): Promise<Attached> {
  const real = await sniff(file)
  const pic = await decode(file)
  let blob: Blob = file
  let mediaType: ImageMediaType | null = real

  try {
    const fits = Math.max(pic.width, pic.height) <= MAX_SIDE
    const passThrough = real !== null && real !== 'image/gif' && fits && file.size <= PASS_THROUGH_BYTES
    if (!passThrough) {
      const scale = Math.min(1, MAX_SIDE / Math.max(pic.width, pic.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(pic.width * scale))
      canvas.height = Math.max(1, Math.round(pic.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('The image could not be converted.')
      ctx.drawImage(pic.source, 0, 0, canvas.width, canvas.height)
      // Keep PNG for screenshots and GIFs (sharp edges, transparency) unless it comes out too big;
      // everything else is JPEG.
      const lossless = real === 'image/png' || real === 'image/gif'
      if (lossless) blob = await toBlob(canvas, 'image/png')
      if (lossless && blob.size <= PASS_THROUGH_BYTES) {
        mediaType = 'image/png'
      } else {
        // JPEG has no transparency: paint white behind the picture.
        ctx.globalCompositeOperation = 'destination-over'
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        blob = await toBlob(canvas, 'image/jpeg', 0.85)
        mediaType = 'image/jpeg'
      }
    }
  } finally {
    pic.close()
  }

  const data = await readBase64(blob)
  if (data.length > MAX_IMAGE_BASE64) throw new Error(`${describe(file)} is larger than 5 MB, even after scaling.`)
  return { mediaType: mediaType!, data, url: URL.createObjectURL(blob) }
}
