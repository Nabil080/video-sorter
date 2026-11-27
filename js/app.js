import * as library from "./library.js";
import * as store from "./store.js";
import { THUMBNAIL_COUNT, loadThumbnails, stopThumbnails, deleteThumbnails } from "./thumbnails.js";

const $ = (id) => document.getElementById(id);
const player = $("player-video");

let folders = []; // { name, handle, locked, videos }
let videos = [];
let selectedKey = null;
let videoUrl = null;
let thumbnailUrls = [];
let toastTimer = null;

// video key -> { status: "keep" | "delete", name, path, size }
const decisions = new Map();

const SORTS = {
  biggest: (a, b) => b.size - a.size,
  smallest: (a, b) => a.size - b.size,
  oldest: (a, b) => a.lastModified - b.lastModified,
  newest: (a, b) => b.lastModified - a.lastModified,
};

function formatSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  return Math.round(bytes / 1e6) + " MB";
}

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function totalSize(list) {
  return list.reduce((total, item) => total + item.size, 0);
}

function statusOf(video) {
  return decisions.get(video.key)?.status ?? "unsorted";
}

function selectedVideo() {
  return videos.find((video) => video.key === selectedKey);
}

function showToast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2500);
}

// The same file can show up in two folders if they overlap: keep one.
function collectVideos() {
  const byKey = new Map();

  for (const folder of folders) {
    for (const video of folder.videos) {
      if (!byKey.has(video.key)) byKey.set(video.key, video);
    }
  }

  videos = [...byKey.values()];
}

// "replay -2025" keeps names containing "replay" but not "2025".
function matchesFilter(video, words) {
  const name = video.name.toLowerCase();

  return words.every((word) => {
    if (word.startsWith("-") && word.length > 1) return !name.includes(word.slice(1));
    return name.includes(word);
  });
}

function visibleVideos() {
  const words = $("filter").value.toLowerCase().split(/\s+/).filter(Boolean);
  const onlyUnsorted = $("only-unsorted").checked;

  return videos
    .filter((video) => matchesFilter(video, words))
    .filter((video) => !onlyUnsorted || statusOf(video) === "unsorted" || video.key === selectedKey)
    .sort(SORTS[$("sort").value]);
}

function renderCounts() {
  for (const status of ["unsorted", "keep", "delete"]) {
    const group = videos.filter((video) => statusOf(video) === status);
    $(`count-${status}`).textContent = `${group.length} (${formatSize(totalSize(group))})`;
  }
}

function renderFolders() {
  const list = $("folder-list");
  list.innerHTML = "";

  for (const folder of folders) {
    const item = document.createElement("li");
    item.classList.toggle("locked", folder.locked);

    const label = document.createElement("span");
    label.textContent = folder.locked
      ? `${folder.name} (needs access)`
      : `${folder.name} · ${folder.videos.length} videos`;

    const removeButton = document.createElement("button");
    removeButton.className = "remove";
    removeButton.textContent = "×";
    removeButton.title = "Stop listing this folder (nothing is deleted)";
    removeButton.onclick = () => removeFolder(folder);

    item.append(label, removeButton);
    list.appendChild(item);
  }

  $("reconnect").hidden = !folders.some((folder) => folder.locked);
}

function emptyListMessage() {
  if (videos.length) return "No video matches these filters.";
  if (folders.some((folder) => folder.locked)) return 'Click "Allow access again" to see your videos.';
  return "No videos yet. Add a folder above.";
}

function renderList() {
  const list = $("list");
  const shown = visibleVideos();
  list.innerHTML = "";

  if (!shown.length) {
    const message = document.createElement("p");
    message.className = "empty";
    message.textContent = emptyListMessage();
    list.appendChild(message);
  }

  for (const video of shown) {
    const row = document.createElement("div");
    row.className = `row ${statusOf(video)}`;
    row.classList.toggle("selected", video.key === selectedKey);
    row.innerHTML = `
      <span class="dot"></span>
      <span class="text"><span class="name"></span><span class="meta"></span></span>
      <span class="size"></span>`;

    const folderPath = video.path.split("/").slice(0, -1).join("/");
    row.querySelector(".name").textContent = video.name;
    row.querySelector(".meta").textContent = `${folderPath} · ${formatDate(video.lastModified)}`;
    row.querySelector(".size").textContent = formatSize(video.size);
    row.onclick = () => selectVideo(video.key);

    list.appendChild(row);
    if (video.key === selectedKey) row.scrollIntoView({ block: "nearest" });
  }

  renderCounts();
  $("welcome").hidden = folders.length > 0;
  $("player").hidden = !selectedVideo();
}

function renderTitle(video) {
  const details = document.createElement("span");
  details.className = "meta";
  details.textContent = [
    formatSize(video.size),
    video.path,
    formatDate(video.lastModified),
    statusOf(video),
  ].join(" · ");

  $("title").textContent = video.name;
  $("title").appendChild(details);
}

function unloadPlayer() {
  player.pause();
  player.removeAttribute("src");
  player.load();

  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = null;
  stopThumbnails();
}

function seekTo(fraction) {
  if (player.duration) player.currentTime = player.duration * fraction;
}

function skip(seconds) {
  player.currentTime = Math.max(0, player.currentTime + seconds);
}

function togglePlay() {
  if (player.paused) player.play();
  else player.pause();
}

// The speed sticks for the next videos too.
function setSpeed(rate) {
  rate = Math.min(16, Math.max(0.25, rate));
  player.playbackRate = rate;
  player.defaultPlaybackRate = rate;
  showToast(`Speed ×${rate}`);
}

function showThumbnails(video, file) {
  const strip = $("thumbnails");
  strip.innerHTML = "";

  thumbnailUrls.forEach((url) => URL.revokeObjectURL(url));
  thumbnailUrls = [];

  const placeholders = [];
  for (let i = 0; i < THUMBNAIL_COUNT; i++) {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    strip.appendChild(placeholder);
    placeholders.push(placeholder);
  }

  const onThumbnail = (i, blob) => {
    if (selectedKey !== video.key) return;

    const position = (i + 0.5) / THUMBNAIL_COUNT;
    const image = document.createElement("img");
    image.src = URL.createObjectURL(blob);
    image.alt = `Frame at ${Math.round(position * 100)} %`;
    image.onclick = () => {
      seekTo(position);
      player.play();
    };

    thumbnailUrls.push(image.src);
    placeholders[i].replaceWith(image);
  };

  loadThumbnails(video.key, file, onThumbnail).catch(() => {
    if (selectedKey !== video.key) return;
    strip.innerHTML = '<p class="note">No thumbnails for this file.</p>';
  });
}

async function selectVideo(key) {
  const video = videos.find((v) => v.key === key);
  if (!video) return;

  selectedKey = key;
  unloadPlayer();
  $("play-error").hidden = true;
  renderTitle(video);
  renderList();

  let file;
  try {
    file = await library.readFile(video);
  } catch {
    showToast("This file was moved or changed. Remove its folder and add it again.");
    return;
  }

  if (selectedKey !== key) return; // another video was picked while reading

  videoUrl = URL.createObjectURL(file);
  player.src = videoUrl;
  showThumbnails(video, file);
}

function selectFirstUnsorted() {
  const first = visibleVideos().find((video) => statusOf(video) === "unsorted");
  if (first) selectVideo(first.key);
}

function step(offset) {
  const list = visibleVideos();
  const index = list.findIndex((video) => video.key === selectedKey);
  const next = list[index + offset];

  if (next) selectVideo(next.key);
}

function selectNextUnsorted() {
  const list = visibleVideos();
  const index = list.findIndex((video) => video.key === selectedKey);
  const isUnsorted = (video) => statusOf(video) === "unsorted" && video.key !== selectedKey;

  const next = list.slice(index + 1).find(isUnsorted) ?? list.find(isUnsorted);
  if (next) {
    selectVideo(next.key);
  } else {
    renderTitle(selectedVideo());
    renderList();
    showToast("Nothing left to sort here");
  }
}

async function decide(status) {
  const video = selectedVideo();
  if (!video) return;

  if (status === "unsorted") {
    decisions.delete(video.key);
    await store.remove("decisions", video.key);

    showToast("Back to unsorted");
    renderTitle(video);
    renderList();
    return;
  }

  const decision = { status, name: video.name, path: video.path, size: video.size };
  decisions.set(video.key, decision);
  await store.put("decisions", video.key, decision);

  showToast(status === "keep" ? "Marked keep" : "Marked delete (nothing is deleted yet)");
  selectNextUnsorted();
}

async function loadDecisions() {
  for (const [key, decision] of await store.getAll("decisions")) {
    decisions.set(key, decision);
  }
}

function refresh() {
  collectVideos();
  renderFolders();
  renderList();

  if (!selectedVideo()) selectFirstUnsorted();
}

async function scan(folder) {
  showToast(`Looking for videos in ${folder.name}...`);
  folder.videos = await library.findVideos(folder.handle, (count) => {
    showToast(`Looking for videos in ${folder.name}... ${count}`);
  });
  folder.locked = false;
  showToast(`${folder.name}: ${folder.videos.length} videos`);
}

async function addFolder() {
  if (!library.canDelete) {
    $("folder-input").click();
    return;
  }

  const handle = await library.pickFolder();
  if (!handle) return;

  if (!(await library.saveFolder(handle))) {
    showToast(`${handle.name} is already in the list`);
    return;
  }

  const folder = { name: handle.name, handle, locked: false, videos: [] };
  folders.push(folder);
  renderFolders();
  await scan(folder);
  refresh();
}

// Firefox and Safari: the files stay on disk, we only get File objects.
function addFolderFromInput() {
  const found = library.videosFromInput($("folder-input").files);
  $("folder-input").value = "";

  if (!found.length) {
    showToast("No videos in this folder");
    return;
  }

  const name = found[0].path.split("/")[0];
  folders = folders.filter((folder) => folder.name !== name);
  folders.push({ name, handle: null, locked: false, videos: found });

  showToast(`${name}: ${found.length} videos`);
  refresh();
}

async function removeFolder(folder) {
  if (folder.handle) await library.unsaveFolder(folder.handle);

  if (folder.videos.includes(selectedVideo())) {
    unloadPlayer();
    selectedKey = null;
  }

  folders = folders.filter((f) => f !== folder);
  refresh();
}

async function loadSavedFolders() {
  for (const handle of await library.getSavedFolders()) {
    const folder = { name: handle.name, handle, locked: true, videos: [] };
    folders.push(folder);

    try {
      if (await library.hasPermission(handle, "read")) await scan(folder);
    } catch {
      // The folder was moved or deleted. It stays in the list so it can be removed.
    }
  }
}

// After a browser restart, Chrome and Edge ask again before giving access back.
async function reconnect() {
  for (const folder of folders.filter((f) => f.locked)) {
    if (await library.askPermission(folder.handle, "read")) await scan(folder);
  }
  refresh();
}

async function deleteMarked() {
  const marked = videos.filter((video) => statusOf(video) === "delete");
  if (!marked.length) {
    showToast("No video is marked delete");
    return;
  }

  const question = `Permanently delete ${marked.length} videos (${formatSize(totalSize(marked))})?\n\n`
    + "They won't go to the Recycle Bin. This can't be undone.";
  if (!confirm(question)) return;

  const allowedFolders = new Set();
  for (const folder of new Set(marked.map((video) => video.folder))) {
    if (await library.askPermission(folder, "readwrite")) allowedFolders.add(folder);
  }

  // Close the file in case the player or the thumbnails still have it open.
  unloadPlayer();

  const deleted = [];
  for (const video of marked) {
    if (!allowedFolders.has(video.folder)) continue;

    try {
      await library.deleteFile(video);
      deleted.push(video);
      decisions.delete(video.key);
      await store.remove("decisions", video.key);
      await deleteThumbnails(video.key);
    } catch (error) {
      console.error(`Could not delete ${video.path}`, error);
    }
  }

  for (const folder of folders) {
    folder.videos = folder.videos.filter((video) => !deleted.includes(video));
  }
  selectedKey = null;
  refresh();

  const failed = marked.length - deleted.length;
  let message = `Deleted ${deleted.length} videos, ${formatSize(totalSize(deleted))} freed.`;
  if (failed) message += ` ${failed} could not be deleted (no permission or file in use).`;
  showToast(message);
}

function exportList() {
  const marked = [...decisions.values()].filter((decision) => decision.status === "delete");
  if (!marked.length) {
    showToast("No video is marked delete");
    return;
  }

  const lines = [
    `# ${marked.length} videos marked delete (${formatSize(totalSize(marked))})`,
    "# Paths start at the folder you picked.",
    ...marked.map((decision) => decision.path),
  ];
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "videos-to-delete.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function forgetEverything() {
  if (!confirm("Forget all decisions, thumbnails and folders? Your videos are not touched.")) return;

  unloadPlayer();
  await store.clearAll();
  location.reload();
}

const shortcuts = {
  "k": () => decide("keep"),
  "d": () => decide("delete"),
  "delete": () => decide("delete"),
  "u": () => decide("unsorted"),
  "arrowleft": () => step(-1),
  "arrowright": () => step(1),
  " ": togglePlay,
  "j": () => skip(-30),
  "l": () => skip(30),
  "+": () => setSpeed(player.playbackRate * 2),
  "-": () => setSpeed(player.playbackRate / 2),
};

function onKeyDown(event) {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName);
  if (typing || $("about").open || !selectedVideo()) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const key = event.key.toLowerCase();

  if (key >= "1" && key <= "9") {
    seekTo(Number(key) / 10);
  } else if (shortcuts[key]) {
    shortcuts[key]();
  } else {
    return;
  }

  event.preventDefault();
}

$("add-folder").onclick = addFolder;
$("choose-folder").onclick = addFolder;
$("folder-input").onchange = addFolderFromInput;
$("reconnect").onclick = reconnect;

$("keep").onclick = () => decide("keep");
$("delete").onclick = () => decide("delete");
$("unsort").onclick = () => decide("unsorted");
$("previous").onclick = () => step(-1);
$("next").onclick = () => step(1);

$("filter").oninput = renderList;
$("sort").onchange = renderList;
$("only-unsorted").onchange = renderList;

$("export").onclick = exportList;
$("delete-marked").onclick = deleteMarked;
$("about-button").onclick = () => $("about").showModal();
$("forget-everything").onclick = forgetEverything;

player.onerror = () => {
  if (player.getAttribute("src")) $("play-error").hidden = false;
};

document.addEventListener("keydown", onKeyDown);

async function start() {
  $("read-only").hidden = library.canDelete;
  $("delete-marked").hidden = !library.canDelete;
  $("welcome-delete-note").hidden = !library.canDelete;

  await loadDecisions();
  if (library.canDelete) await loadSavedFolders();
  refresh();
}

start();
