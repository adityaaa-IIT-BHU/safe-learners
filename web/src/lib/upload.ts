import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from './firebase';

const MAX_DIMENSION = 1600;

/** Shrinks large photos in the browser before upload (keeps PDFs and small files untouched). */
async function compressImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.size < 400_000 || file.type === 'image/gif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/** Uploads a file and returns its download URL. */
export async function uploadFile(path: string, file: File): Promise<string> {
  const body = await compressImage(file);
  const contentType = body === file ? file.type : 'image/jpeg';
  const target = ref(storage, path);
  await uploadBytes(target, body, { contentType });
  return getDownloadURL(target);
}
