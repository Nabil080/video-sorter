// Thumbnails are grabbed from a hidden <video>: seek, draw the frame on a
// canvas, repeat. The browser only reads the part of the file around each
// position, so it stays fast even on a 50 GB recording.

import * as store from "./store.js";

export const THUMBNAIL_COUNT = 10;

const WIDTH = 320;
const TIMEOUT_MS = 8000;

const video = document.createElement("video");
video.muted = true;
video.preload = "auto";

const canvas = document.createElement("canvas");

let activeKey = null;

function waitFor(eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Timed out waiting for ${eventName}`)), TIMEOUT_MS);
    const onEvent = () => done();
    const onError = () => done(new Error("Can't read this video"));

    function done(error) {
      clearTimeout(timer);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    }

    video.addEventListener(eventName, onEvent);
    video.addEventListener("error", onError);
  });
}

function captureFrame() {
  canvas.width = WIDTH;
  canvas.height = Math.round((WIDTH * video.videoHeight) / video.videoWidth) || 180;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));
}

function unloadVideo() {
  video.removeAttribute("src");
  video.load();
}

// Calls onThumbnail(index, blob) as soon as each one is ready.
// If another video is requested in the meantime, this one just stops.
export async function loadThumbnails(key, file, onThumbnail) {
  const cached = await store.get("thumbs", key);
  if (cached) {
    cached.forEach((blob, i) => onThumbnail(i, blob));
    return;
  }

  activeKey = key;
  const url = URL.createObjectURL(file);
  const blobs = [];

  try {
    video.src = url;
    await waitFor("loadedmetadata");

    for (let i = 0; i < THUMBNAIL_COUNT; i++) {
      if (activeKey !== key) return;

      video.currentTime = (video.duration * (i + 0.5)) / THUMBNAIL_COUNT;
      await waitFor("seeked");
      if (activeKey !== key) return;

      blobs.push(await captureFrame());
      onThumbnail(i, blobs[i]);
    }

    await store.put("thumbs", key, blobs);
  } finally {
    if (activeKey === key) {
      activeKey = null;
      unloadVideo();
    }
    URL.revokeObjectURL(url);
  }
}

export function stopThumbnails() {
  activeKey = null;
  unloadVideo();
}

export function deleteThumbnails(key) {
  return store.remove("thumbs", key);
}
