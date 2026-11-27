// Finding videos on disk. Chromium browsers have the File System Access API:
// we get folder handles that can be saved between visits and used to delete
// files. Firefox and Safari only have <input webkitdirectory>, which is
// read-only and has to be picked again on every visit.

import * as store from "./store.js";

export const canDelete = "showDirectoryPicker" in window;

const VIDEO_EXTENSIONS = /\.(mp4|mkv|mov|webm|m4v)$/i;

// Name, size and date are enough to recognise a file on the next visit,
// even if its folder was renamed or is now on another drive letter.
function videoKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function toVideo(file, path, folder = null, parent = null) {
  return {
    key: videoKey(file),
    name: file.name,
    path,
    size: file.size,
    lastModified: file.lastModified,
    file,
    folder, // handle of the folder the user picked
    parent, // handle of the folder the file is in, needed to delete it
  };
}

export async function pickFolder() {
  try {
    return await window.showDirectoryPicker({ id: "video-sorter", mode: "read" });
  } catch (error) {
    if (error.name === "AbortError") return null;
    throw error;
  }
}

// Returns false if that folder was already saved.
export async function saveFolder(handle) {
  for (const [, saved] of await store.getAll("folders")) {
    if (await saved.isSameEntry(handle)) return false;
  }

  await store.put("folders", crypto.randomUUID(), handle);
  return true;
}

export async function unsaveFolder(handle) {
  for (const [id, saved] of await store.getAll("folders")) {
    if (await saved.isSameEntry(handle)) {
      await store.remove("folders", id);
    }
  }
}

export async function getSavedFolders() {
  const entries = await store.getAll("folders");
  return entries.map(([, handle]) => handle);
}

export async function hasPermission(handle, mode) {
  return (await handle.queryPermission({ mode })) === "granted";
}

// Shows the browser's permission prompt, so it has to run from a click.
export async function askPermission(handle, mode) {
  if (await hasPermission(handle, mode)) return true;
  return (await handle.requestPermission({ mode })) === "granted";
}

export async function findVideos(folder, onProgress) {
  const videos = [];

  async function walk(dir, path) {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory") {
        await walk(handle, `${path}${name}/`);
      } else if (VIDEO_EXTENSIONS.test(name)) {
        const file = await handle.getFile();
        videos.push(toVideo(file, path + name, folder, dir));
        onProgress(videos.length);
      }
    }
  }

  await walk(folder, `${folder.name}/`);
  return videos;
}

export function videosFromInput(files) {
  return [...files]
    .filter((file) => VIDEO_EXTENSIONS.test(file.name))
    .map((file) => toVideo(file, file.webkitRelativePath || file.name));
}

// With a handle we read the file again, in case it changed since the scan
// (OBS still recording into it, for example).
export async function readFile(video) {
  if (!video.parent) return video.file;

  const handle = await video.parent.getFileHandle(video.name);
  return handle.getFile();
}

export function deleteFile(video) {
  return video.parent.removeEntry(video.name);
}
