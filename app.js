// ========================================================
// PHYSICS STUDY BD - ULTRA-PREMIUM APPLICATION LOGIC
// ========================================================

let currentCourseIndex = 0;
let currentPlayingLec = null;
let currentPlaylistFlat = [];
let currentPlaylistIndex = 0;

let watchedLectures = JSON.parse(localStorage.getItem('watched_lectures') || '[]');
let bookmarkedLectures = JSON.parse(localStorage.getItem('bookmarked_lectures') || '[]');
let watchHistory = JSON.parse(localStorage.getItem('watch_history') || localStorage.getItem('watched_lectures') || '[]');
let videoTimestamps = JSON.parse(localStorage.getItem('video_timestamps') || '{}');

function saveVideoProgress(url, time) {
  if (!url || typeof time !== 'number' || isNaN(time)) return;
  videoTimestamps[url] = Math.floor(time);
  try {
    localStorage.setItem('video_timestamps', JSON.stringify(videoTimestamps));
  } catch (e) { }
}

function getVideoProgress(url) {
  if (!url) return 0;
  return Number(videoTimestamps[url]) || 0;
}

// Watch History Recorder (tracks recently watched videos, timestamps & progress)
function recordWatchHistory(item, currentSec = 0, durationSec = 0) {
  if (!item || !item.url) return;
  const details = findLectureDetails(item.url) || {};
  const courseIdx = item.courseIdx !== undefined ? item.courseIdx : (details.courseIdx !== undefined ? details.courseIdx : 0);
  const lecTitle = item.lecTitle || details.lecTitle || 'লেকচার';
  const chName = item.chName || details.chName || 'অধ্যায়';
  const subName = item.subName !== undefined ? item.subName : (details.subName || null);

  const historyObj = {
    url: item.url,
    lecTitle,
    chName,
    subName,
    courseIdx,
    progress: Math.floor(currentSec),
    duration: Math.floor(durationSec),
    lastWatchedAt: Date.now()
  };

  const idx = watchHistory.findIndex(h => h.url === item.url);
  if (idx >= 0) {
    watchHistory.splice(idx, 1);
  }
  watchHistory.unshift(historyObj);
  if (watchHistory.length > 100) watchHistory.pop();
  try {
    localStorage.setItem('watch_history', JSON.stringify(watchHistory));
    localStorage.setItem('watched_lectures', JSON.stringify(watchHistory));
  } catch (e) { }
  updateBadges();
}

// Clean URL Deep Linking & State Persistence
function setUrlState(view, params = {}) {
  let newHash = '';
  if (view === 'course') {
    const parts = [];
    if (params.c !== undefined && params.c !== null) parts.push(`c=${params.c}`);
    if (params.v) parts.push(`v=${params.v}`);
    newHash = '#' + parts.join('&');
  } else if (view === 'bookmarks' || view === 'history' || view === 'admin') {
    newHash = '#' + view;
  } else {
    newHash = '#';
  }

  if (window.location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }
}

function parseUrlState() {
  // 1. Check Search Query parameters (?id=... or ?v=... or ?course=...)
  const queryParams = new URLSearchParams(window.location.search);
  const qVid = queryParams.get('id') || queryParams.get('v') || queryParams.get('vid');
  const qCourse = queryParams.get('course') || queryParams.get('c');
  const qTab = queryParams.get('tab') || queryParams.get('view');

  // 2. Check Hash parameters (#c=0&v=... or #bookmarks or #history)
  const rawHash = window.location.hash.replace(/^#/, '');
  let hashView = '';
  let hashCourse = null;
  let hashVid = null;

  if (rawHash) {
    if (rawHash === 'bookmarks' || rawHash === 'history' || rawHash === 'admin' || rawHash === 'home') {
      hashView = rawHash;
    } else {
      const hashParams = new URLSearchParams(rawHash);
      hashView = hashParams.get('view') || hashParams.get('tab') || '';
      hashCourse = hashParams.get('course') || hashParams.get('c');
      hashVid = hashParams.get('v') || hashParams.get('id') || hashParams.get('vid');
    }
  }

  const finalVid = hashVid || qVid || null;
  const finalCourse = hashCourse !== null ? hashCourse : (qCourse !== null ? qCourse : null);
  const finalView = hashView || qTab || (finalVid || finalCourse !== null ? 'course' : 'home');

  return {
    view: finalView,
    courseIdx: finalCourse !== null && !isNaN(parseInt(finalCourse, 10)) ? parseInt(finalCourse, 10) : null,
    vid: finalVid
  };
}

let isRestoringUrl = false;
function restoreStateFromUrl() {
  if (isRestoringUrl) return;
  isRestoringUrl = true;
  try {
    const state = parseUrlState();
    if (state.view === 'bookmarks') {
      showBookmarksView(false);
    } else if (state.view === 'history') {
      showHistoryView(false);
    } else if (state.view === 'admin') {
      showAdminView(false);
    } else if (state.vid || state.courseIdx !== null) {
      if (state.vid) {
        const details = findLectureDetails(state.vid);
        const cIdx = details ? details.courseIdx : (state.courseIdx !== null ? state.courseIdx : 0);
        const chName = details ? details.chName : '';
        const subName = details ? details.subName : null;
        const lecTitle = details ? details.lecTitle : 'লেকচার';
        const targetUrl = details ? details.url : state.vid;
        playSpecificLecture(cIdx, chName, subName, targetUrl, lecTitle, null, false);
      } else {
        const cIdx = state.courseIdx !== null && !isNaN(state.courseIdx) ? state.courseIdx : 0;
        selectCourse(cIdx, false, true);
      }
    } else {
      showHomeView(false);
    }
  } finally {
    isRestoringUrl = false;
  }
}

let ytPlayer = null;
let isYtReady = false;
let isPlaying = false;
let isMuted = false;
let progressInterval = null;
let hideControlsTimeout = null;
let lastClickTimestamp = 0;
let clickTimer = null;
let currentStreamMode = 'telegram'; // 'telegram' | 'youtube'

function getStreamApiUrl(tgUrl) {
  if (!tgUrl) return null;
  const isLocalStatic = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
                        (window.location.port === '3000' || window.location.port === '5500' || window.location.port === '8080');
  const base = isLocalStatic ? 'http://localhost:8000' : '';
  return `${base}/api/stream?url=${encodeURIComponent(tgUrl)}`;
}

// Helper to look up course & lecture details for any video URL, TG URL, or Video ID
function findLectureDetails(query) {
  if (!query) return null;
  const targetId = extractYouTubeId(query) || query;
  const courses = window.COURSES_DATA || [];
  for (let cIdx = 0; cIdx < courses.length; cIdx++) {
    const c = courses[cIdx];
    if (!c || !c.chapters) continue;
    for (const [chName, chVal] of Object.entries(c.chapters)) {
      if (Array.isArray(chVal)) {
        for (const lec of chVal) {
          const lecId = extractYouTubeId(lec.url) || lec.url;
          if (lec.url === query || lec.tg_url === query || lecId === query || lecId === targetId) {
            return { courseIdx: cIdx, courseName: c.course_name, chName, subName: null, lecTitle: lec.lecture, url: lec.url, tg_url: lec.tg_url, vid: lecId };
          }
        }
      } else if (typeof chVal === 'object') {
        for (const [subName, subVal] of Object.entries(chVal)) {
          if (Array.isArray(subVal)) {
            for (const lec of subVal) {
              const lecId = extractYouTubeId(lec.url) || lec.url;
              if (lec.url === query || lec.tg_url === query || lecId === query || lecId === targetId) {
                return { courseIdx: cIdx, courseName: c.course_name, chName, subName, lecTitle: lec.lecture, url: lec.url, tg_url: lec.tg_url, vid: lecId };
              }
            }
          }
        }
      }
    }
  }
  return null;
}

// DOM Elements
const navHome = document.getElementById('nav-home');
const navBookmarks = document.getElementById('nav-bookmarks');
const navHistory = document.getElementById('nav-history');

const viewHome = document.getElementById('view-home');
const viewPlayer = document.getElementById('view-player');
const viewSearch = document.getElementById('view-search-results');

const courseGrid = document.getElementById('course-grid');
const sidebarCoursesList = document.getElementById('sidebar-courses-list');

const videoScreenBox = document.getElementById('video-screen-box');
const html5Video = document.getElementById('html5-video-player');
const ytWrapper = document.getElementById('yt-embed-wrapper');
const videoPlaceholder = document.getElementById('video-placeholder');
const playerCoursePill = document.getElementById('player-course-pill');
const playerChapterText = document.getElementById('player-chapter-text');
const playerVideoTitle = document.getElementById('player-video-title');
const overlayVideoTitle = document.getElementById('overlay-video-title');
const playerStreamBadge = document.getElementById('player-stream-badge');
const playlistCourseTitle = document.getElementById('playlist-course-title');
const playlistSubtitle = document.getElementById('playlist-subtitle');
const playlistAccordionContainer = document.getElementById('playlist-accordion-container');
const courseProgressText = document.getElementById('course-progress-text');

const ctrlPlayIcon = document.getElementById('ctrl-play-icon');
const ctrlVolIcon = document.getElementById('ctrl-vol-icon');
const ctrlTimeText = document.getElementById('ctrl-time-text');
const progressPlayed = document.getElementById('progress-played');
const progressBuffered = document.getElementById('progress-buffered');
const progressThumb = document.getElementById('progress-thumb');
const progressHoverTime = document.getElementById('progress-hover-time');
const currentSpeedLabel = document.getElementById('current-speed-label');
const currentQualityLabel = document.getElementById('current-quality-label');
const speedDropupMenu = document.getElementById('speed-dropup-menu');
const qualityDropupMenu = document.getElementById('quality-dropup-menu');
const centerPlayIndicator = document.getElementById('center-play-indicator');
const centerPlayIcon = document.getElementById('center-play-icon');

const bookmarkCount = document.getElementById('bookmark-count');
const watchedCount = document.getElementById('watched-count');
const totalLecturesCount = document.getElementById('total-lectures-count');
const totalCoursesCount = document.getElementById('total-courses-count');

// Subject Icon Mapping
const COURSE_ICONS = {
  'ict': 'fa-laptop-code',
  'তথ্য': 'fa-laptop-code',
  'ক্যালকুলাস': 'fa-square-root-variable',
  'তাপ': 'fa-temperature-high',
  'তরঙ্গ': 'fa-water',
  'ম্যাথমেটিকস': 'fa-calculator',
  'বলবিদ্যা': 'fa-meteor',
  'ইতিহাস': 'fa-landmark-dome',
  'পরিসংখ্যান': 'fa-chart-pie',
  'রসায়ন': 'fa-flask-vial'
};

function getCourseIcon(name) {
  if (!name) return 'fa-atom';
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(COURSE_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return 'fa-atom';
}

function setupHtml5VideoEvents() {
  const v = document.getElementById('html5-video-player');
  if (!v) return;

  v.addEventListener('play', () => {
    if (currentStreamMode !== 'telegram') return;
    isPlaying = true;
    if (ctrlPlayIcon) ctrlPlayIcon.className = 'fa-solid fa-pause';
    startProgressLoop();
    resetHideControlsTimer();
  });

  v.addEventListener('pause', () => {
    if (currentStreamMode !== 'telegram') return;
    isPlaying = false;
    if (ctrlPlayIcon) ctrlPlayIcon.className = 'fa-solid fa-play';
    stopProgressLoop();
    showPlayerControls();
    if (currentPlayingLec && v.currentTime > 2) {
      saveVideoProgress(currentPlayingLec.url, v.currentTime);
    }
  });

  v.addEventListener('timeupdate', () => {
    if (currentStreamMode !== 'telegram') return;
    updatePlayerProgress();
  });

  v.addEventListener('ended', () => {
    if (currentStreamMode !== 'telegram') return;
    isPlaying = false;
    if (ctrlPlayIcon) ctrlPlayIcon.className = 'fa-solid fa-play';
    stopProgressLoop();
    showPlayerControls();
    if (currentPlayingLec) {
      saveVideoProgress(currentPlayingLec.url, 0);
      markCurrentAsWatched();
      playNextLecture();
    }
  });

  v.addEventListener('error', (e) => {
    if (currentStreamMode === 'telegram' && currentPlayingLec && currentPlayingLec.url) {
      console.warn("Telegram video stream error/unavailable, switching to YouTube:", e);
      showToast("টেলিগ্রাম স্ট্রিম সাময়িক অনুপলব্ধ, ইউটিউবে চালানো হচ্ছে...");
      switchToYouTube(currentPlayingLec.url, v.currentTime || 0);
    }
  });

  v.addEventListener('loadedmetadata', () => {
    if (currentStreamMode === 'telegram') {
      updatePlayerProgress();
    }
  });
}

function switchToYouTube(url, seekTime = 0) {
  const v = document.getElementById('html5-video-player');
  const ytW = document.getElementById('yt-embed-wrapper');
  if (v) {
    v.pause();
    v.classList.add('hidden');
  }
  if (ytW) ytW.classList.remove('hidden');
  currentStreamMode = 'youtube';

  const ytId = extractYouTubeId(url);
  if (!ytId) return;

  if (playerStreamBadge) {
    playerStreamBadge.innerHTML = '<i class="fa-brands fa-youtube" style="color:#ef4444;"></i> YouTube Player';
  }

  if (ytPlayer && isYtReady && typeof ytPlayer.loadVideoById === 'function') {
    ytPlayer.loadVideoById({
      videoId: ytId,
      startSeconds: seekTime > 0 ? seekTime : 0
    });
    try { ytPlayer.playVideo(); } catch (e) {}
    disableCaptions();
  } else if (!ytPlayer && window.YT && window.YT.Player) {
    initYouTubePlayer();
  }
}

// Initialize YouTube Iframe API with youtube-nocookie and origin support
function initYouTubePlayer() {
  if (ytPlayer || !window.YT || !window.YT.Player) return;
  try {
    ytPlayer = new YT.Player('yt-player-host', {
      height: '100%',
      width: '100%',
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        'autoplay': 1,
        'controls': 0,        // Completely removes YouTube control bar, logo, share, and clock
        'modestbranding': 1,  // Disables YouTube branding
        'rel': 0,             // No related channels
        'showinfo': 0,        // No video title/channel header
        'iv_load_policy': 3,  // No video annotations
        'cc_load_policy': 0,  // Disables subtitles / captions completely
        'fs': 0,              // Disables YouTube native fullscreen
        'disablekb': 1,       // Disables YouTube keyboard conflicts
        'playsinline': 1,
        'enablejsapi': 1,
        'origin': window.location.origin || 'http://localhost:3000'
      },
      events: {
        'onReady': onPlayerReady,
        'onStateChange': onPlayerStateChange,
        'onError': onPlayerError
      }
    });
    window.ytPlayer = ytPlayer;
  } catch (e) {
    console.warn("Error initializing YT.Player:", e);
  }
}

window.onYouTubeIframeAPIReady = function () {
  initYouTubePlayer();
};

function onPlayerReady(event) {
  isYtReady = true;
  disableCaptions();
  if (currentPlayingLec && currentStreamMode === 'youtube') {
    const ytId = extractYouTubeId(currentPlayingLec.url);
    if (ytId) {
      const savedTime = getVideoProgress(currentPlayingLec.url);
      ytPlayer.loadVideoById({
        videoId: ytId,
        startSeconds: savedTime > 0 ? savedTime : 0
      });
      try { ytPlayer.playVideo(); } catch (e) {}
      disableCaptions();
    }
  } else {
    // If state has video, restore it
    const state = parseUrlState();
    if (state.vid) {
      const details = findLectureDetails(state.vid);
      if (details) {
        playSpecificLecture(details.courseIdx, details.chName, details.subName, details.url, details.lecTitle, null, false, details.tg_url);
      }
    }
  }
}

function onPlayerError(event) {
  console.warn("YouTube Player Error:", event.data);
}

function disableCaptions() {
  if (!ytPlayer) return;
  try {
    if (typeof ytPlayer.unloadModule === 'function') {
      ytPlayer.unloadModule("captions");
      ytPlayer.unloadModule("cc");
    }
    if (typeof ytPlayer.setOption === 'function') {
      ytPlayer.setOption("captions", "track", {});
    }
  } catch (e) { }
}

function onPlayerStateChange(event) {
  if (currentStreamMode !== 'youtube') return;
  if (event.data === YT.PlayerState.PLAYING) {
    isPlaying = true;
    ctrlPlayIcon.className = 'fa-solid fa-pause';
    disableCaptions();
    startProgressLoop();
    resetHideControlsTimer();
  } else if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
    isPlaying = false;
    ctrlPlayIcon.className = 'fa-solid fa-play';
    stopProgressLoop();
    showPlayerControls();

    if (currentPlayingLec && typeof ytPlayer.getCurrentTime === 'function') {
      const cur = ytPlayer.getCurrentTime() || 0;
      if (event.data === YT.PlayerState.ENDED) {
        saveVideoProgress(currentPlayingLec.url, 0);
      } else if (cur > 2) {
        saveVideoProgress(currentPlayingLec.url, cur);
      }
    }

    if (event.data === YT.PlayerState.ENDED) {
      markCurrentAsWatched();
      playNextLecture();
    }
  }
}

// Progress Loop
function startProgressLoop() {
  stopProgressLoop();
  progressInterval = setInterval(updatePlayerProgress, 250);
}

function stopProgressLoop() {
  if (progressInterval) clearInterval(progressInterval);
}

function formatDuration(sec) {
  if (isNaN(sec) || sec === null || sec < 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

function updatePlayerProgress() {
  let current = 0;
  let duration = 0;
  let loadedFraction = 0;

  const v = document.getElementById('html5-video-player');
  if (currentStreamMode === 'telegram' && v) {
    current = v.currentTime || 0;
    duration = v.duration || 0;
    if (v.buffered && v.buffered.length > 0 && duration > 0) {
      loadedFraction = v.buffered.end(v.buffered.length - 1) / duration;
    }
  } else if (ytPlayer && isYtReady && typeof ytPlayer.getCurrentTime === 'function') {
    current = ytPlayer.getCurrentTime() || 0;
    duration = ytPlayer.getDuration() || 0;
    loadedFraction = ytPlayer.getVideoLoadedFraction ? ytPlayer.getVideoLoadedFraction() : 0;
  } else {
    return;
  }

  if (ctrlTimeText) {
    ctrlTimeText.innerText = `${formatDuration(current)} / ${formatDuration(duration)}`;
  }

  if (duration > 0) {
    const pct = (current / duration) * 100;
    if (progressPlayed) progressPlayed.style.width = `${pct}%`;
    if (progressThumb) progressThumb.style.left = `${pct}%`;
    if (progressBuffered) progressBuffered.style.width = `${Math.min(100, loadedFraction * 100)}%`;
  }

  // Periodic timestamp saving and watch history update
  if (currentPlayingLec && currentPlayingLec.url && current > 2 && (duration === 0 || current < duration - 3)) {
    saveVideoProgress(currentPlayingLec.url, current);
    recordWatchHistory(currentPlayingLec, current, duration);
  }
}

// Progress Bar Interactions
window.handleProgressClick = function (e) {
  const bar = e.currentTarget;
  const rect = bar.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const pct = Math.max(0, Math.min(1, clickX / rect.width));

  const v = document.getElementById('html5-video-player');
  if (currentStreamMode === 'telegram' && v) {
    const duration = v.duration || 0;
    if (duration > 0) {
      v.currentTime = pct * duration;
      updatePlayerProgress();
    }
  } else if (ytPlayer && isYtReady && typeof ytPlayer.getDuration === 'function') {
    const duration = ytPlayer.getDuration() || 0;
    if (duration > 0) {
      ytPlayer.seekTo(pct * duration, true);
      updatePlayerProgress();
    }
  }
};

window.handleProgressHover = function (e) {
  const bar = e.currentTarget;
  const rect = bar.getBoundingClientRect();
  const hoverX = e.clientX - rect.left;
  const pct = Math.max(0, Math.min(1, hoverX / rect.width));

  let duration = 0;
  const v = document.getElementById('html5-video-player');
  if (currentStreamMode === 'telegram' && v) {
    duration = v.duration || 0;
  } else if (ytPlayer && isYtReady && typeof ytPlayer.getDuration === 'function') {
    duration = ytPlayer.getDuration() || 0;
  }

  if (progressHoverTime) {
    progressHoverTime.style.display = 'block';
    progressHoverTime.style.left = `${hoverX}px`;
    progressHoverTime.innerText = formatDuration(pct * duration);
  }
};

document.addEventListener('mouseleave', () => {
  if (progressHoverTime) progressHoverTime.style.display = 'none';
});

// Gesture & In-Player Clicks (Single click = Play/Pause, Double click = -10s/+10s Seek)
window.handleGestureClick = function (e) {
  if (e.target.closest('.custom-player-controls') || e.target.closest('.custom-player-topbar')) return;

  const now = Date.now();
  const timeDiff = now - lastClickTimestamp;

  if (timeDiff < 300) {
    // Double click detected!
    clearTimeout(clickTimer);
    const rect = videoScreenBox.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;

    if (clickX < width * 0.45) {
      seekRelative(-10);
    } else if (clickX > width * 0.55) {
      seekRelative(10);
    } else {
      togglePlayPause();
    }
  } else {
    // Single click: toggle Play/Pause after debounce
    clickTimer = setTimeout(() => {
      togglePlayPause();
    }, 280);
  }

  lastClickTimestamp = now;
};

window.seekRelative = function (sec) {
  const v = document.getElementById('html5-video-player');
  if (currentStreamMode === 'telegram' && v) {
    const cur = v.currentTime || 0;
    const dur = v.duration || 999999;
    v.currentTime = Math.max(0, Math.min(dur, cur + sec));
    updatePlayerProgress();
  } else if (ytPlayer && isYtReady && typeof ytPlayer.getCurrentTime === 'function') {
    const cur = ytPlayer.getCurrentTime() || 0;
    const target = Math.max(0, cur + sec);
    ytPlayer.seekTo(target, true);
    updatePlayerProgress();
  }

  const el = document.getElementById(`seek-feedback-${sec < 0 ? 'left' : 'right'}`);
  if (el) {
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 550);
  }
};

window.togglePlayPause = function () {
  const v = document.getElementById('html5-video-player');
  if (currentStreamMode === 'telegram' && v) {
    if (v.paused) {
      v.play().catch(() => {});
      showCenterIndicator('play');
    } else {
      v.pause();
      showCenterIndicator('pause');
    }
  } else if (ytPlayer && isYtReady) {
    if (isPlaying) {
      ytPlayer.pauseVideo();
      showCenterIndicator('pause');
    } else {
      ytPlayer.playVideo();
      showCenterIndicator('play');
    }
  }
};

function showCenterIndicator(type) {
  centerPlayIcon.className = type === 'play' ? 'fa-solid fa-play' : 'fa-solid fa-pause';
  centerPlayIndicator.classList.add('show');
  setTimeout(() => centerPlayIndicator.classList.remove('show'), 500);
}

window.toggleMute = function () {
  const v = document.getElementById('html5-video-player');
  if (currentStreamMode === 'telegram' && v) {
    v.muted = !v.muted;
    isMuted = v.muted;
    ctrlVolIcon.className = isMuted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
    showToast(isMuted ? "মিউট করা হয়েছে" : "সাউন্ড চালু করা হয়েছে");
  } else if (ytPlayer && isYtReady) {
    if (ytPlayer.isMuted()) {
      ytPlayer.unMute();
      ctrlVolIcon.className = 'fa-solid fa-volume-high';
      showToast("সাউন্ড চালু করা হয়েছে");
    } else {
      ytPlayer.mute();
      ctrlVolIcon.className = 'fa-solid fa-volume-xmark';
      showToast("মিউট করা হয়েছে");
    }
  }
};

// Quality Selector
window.toggleQualityMenu = function (e) {
  e.stopPropagation();
  if (speedDropupMenu) speedDropupMenu.classList.remove('show');
  qualityDropupMenu.classList.toggle('show');
};

window.setQuality = function (quality, label) {
  currentQualityLabel.innerText = label;
  document.querySelectorAll('#quality-dropup-menu .dropup-item').forEach(item => {
    item.classList.toggle('active', item.innerText.includes(label));
  });
  qualityDropupMenu.classList.remove('show');

  if (currentStreamMode === 'youtube' && ytPlayer && isYtReady && typeof ytPlayer.setPlaybackQuality === 'function') {
    ytPlayer.setPlaybackQuality(quality);
  }
  showToast(`কোয়ালিটি পরিবর্তন: ${label}`);
};

// Speed Control
window.toggleSpeedMenu = function (e) {
  e.stopPropagation();
  if (qualityDropupMenu) qualityDropupMenu.classList.remove('show');
  speedDropupMenu.classList.toggle('show');
};

window.setSpeed = function (rate) {
  currentSpeedLabel.innerText = `${rate}x`;
  document.querySelectorAll('#speed-dropup-menu .dropup-item').forEach(item => {
    item.classList.toggle('active', item.innerText.includes(`${rate}x`));
  });
  speedDropupMenu.classList.remove('show');

  const v = document.getElementById('html5-video-player');
  if (v) {
    v.playbackRate = rate;
  }
  if (ytPlayer && isYtReady && typeof ytPlayer.setPlaybackRate === 'function') {
    ytPlayer.setPlaybackRate(rate);
  }
  showToast(`স্পিড সেট: ${rate}x`);
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.player-dropup')) {
    if (speedDropupMenu) speedDropupMenu.classList.remove('show');
    if (qualityDropupMenu) qualityDropupMenu.classList.remove('show');
  }
});

// Single Fullscreen Toggle Handler (Container Fullscreen)
window.toggleCustomFullscreen = function () {
  const container = document.getElementById('video-screen-box');
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;

  if (!isFs) {
    if (container.requestFullscreen) {
      container.requestFullscreen();
    } else if (container.webkitRequestFullscreen) {
      container.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
};

document.addEventListener('fullscreenchange', updateFsIcon);
document.addEventListener('webkitfullscreenchange', updateFsIcon);

function updateFsIcon() {
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  const fsIcon = document.getElementById('ctrl-fs-icon');
  if (fsIcon) fsIcon.className = isFs ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
}

// Mouse Inactivity Auto-Hide
window.handlePlayerMouseMove = function () {
  showPlayerControls();
  resetHideControlsTimer();
};

window.handlePlayerMouseLeave = function () {
  if (isPlaying) {
    videoScreenBox.classList.add('hide-controls');
  }
};

function showPlayerControls() {
  videoScreenBox.classList.remove('hide-controls');
}

function resetHideControlsTimer() {
  clearTimeout(hideControlsTimeout);
  if (isPlaying) {
    hideControlsTimeout = setTimeout(() => {
      videoScreenBox.classList.add('hide-controls');
    }, 2800);
  }
}

// Mobile Sidebar Navigation Controls
window.toggleMobileSidebar = function () {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    sidebar.classList.toggle('mobile-open');
    overlay.classList.toggle('mobile-open');
  }
};

window.closeMobileSidebar = function () {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('mobile-open');
  }
};

// Keyboard Shortcuts & Modal
window.toggleShortcutsModal = function () {
  const modal = document.getElementById('shortcuts-modal');
  modal.classList.toggle('show');
};

window.closeShortcutsModal = function (e) {
  if (e.target.id === 'shortcuts-modal') {
    document.getElementById('shortcuts-modal').classList.remove('show');
  }
};

document.addEventListener('keydown', (e) => {
  if (document.activeElement.tagName === 'INPUT') return;

  if (e.key === '?' || (e.shiftKey && e.key === '/')) {
    toggleShortcutsModal();
    return;
  }

  if (viewPlayer.classList.contains('hidden')) return;

  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    togglePlayPause();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    seekRelative(-10);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    seekRelative(10);
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleCustomFullscreen();
  } else if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    toggleMute();
  }
});

// Helper: Extract YouTube ID
function extractYouTubeId(url) {
  if (!url) return null;
  if (typeof url === 'string' && url.length === 11 && !url.includes('/') && !url.includes('?') && !url.includes('.')) {
    return url;
  }
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

// Helper: Toast notification
function showToast(msg) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-message');
  if (!toast || !toastMsg) return;
  toastMsg.innerText = msg;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}
window.showToast = showToast;

// Helper: Calculate stats for a course
function getCourseStats(course) {
  let totalLecs = 0;
  let totalChaps = 0;

  if (course.chapters) {
    totalChaps = Object.keys(course.chapters).length;
    for (const [chName, chVal] of Object.entries(course.chapters)) {
      if (Array.isArray(chVal)) {
        totalLecs += chVal.length;
      } else if (typeof chVal === 'object') {
        for (const subVal of Object.values(chVal)) {
          if (Array.isArray(subVal)) {
            totalLecs += subVal.length;
          }
        }
      }
    }
  }
  return { totalLecs, totalChaps };
}

// ========================================================
// AUTHENTICATION & SINGLE DEVICE CONTROLLER
// ========================================================
let currentAuthTab = 'login';

window.switchAuthTab = function (tab) {
  currentAuthTab = tab;
  const loginBtn = document.getElementById('tab-login-btn');
  const regBtn = document.getElementById('tab-register-btn');
  const groupFullName = document.getElementById('group-fullname');
  const groupConfirmPass = document.getElementById('group-confirm-password');
  const submitText = document.getElementById('auth-submit-text');
  const alertBox = document.getElementById('auth-alert');

  if (alertBox) alertBox.classList.add('hidden');

  if (tab === 'register') {
    loginBtn.classList.remove('active');
    regBtn.classList.add('active');
    groupFullName.classList.remove('hidden');
    groupConfirmPass.classList.remove('hidden');
    const nameInput = document.getElementById('auth-fullname');
    const confirmInput = document.getElementById('auth-confirm-password');
    if (nameInput) nameInput.required = true;
    if (confirmInput) confirmInput.required = true;
    submitText.innerHTML = '<i class="fa-solid fa-user-plus"></i> রেজিস্ট্রেশন সম্পন্ন করুন';
  } else {
    regBtn.classList.remove('active');
    loginBtn.classList.add('active');
    groupFullName.classList.add('hidden');
    groupConfirmPass.classList.add('hidden');
    const nameInput = document.getElementById('auth-fullname');
    const confirmInput = document.getElementById('auth-confirm-password');
    if (nameInput) nameInput.required = false;
    if (confirmInput) confirmInput.required = false;
    submitText.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> লগইন করুন';
  }

  const authModal = document.getElementById('auth-modal');
  if (authModal) {
    authModal.scrollTo({ top: 0, behavior: 'smooth' });
  }
};

window.togglePasswordVisibility = function (inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  const icon = btn.querySelector('i');
  if (icon) {
    icon.className = isPassword ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
  }
};

window.showAuthAlert = function (msg, type = 'error') {
  const alertBox = document.getElementById('auth-alert');
  const alertMsg = document.getElementById('auth-alert-message');
  if (!alertBox || !alertMsg) return;

  alertBox.className = `auth-alert ${type}`;
  alertMsg.innerHTML = msg;
  alertBox.classList.remove('hidden');
};

window.handleAuthSubmit = async function (event) {
  event.preventDefault();
  const phone = document.getElementById('auth-phone').value.trim();
  const password = document.getElementById('auth-password').value;
  const submitBtn = document.getElementById('auth-submit-btn');
  const spinner = document.getElementById('auth-submit-spinner');
  const submitText = document.getElementById('auth-submit-text');

  const alertBox = document.getElementById('auth-alert');
  if (alertBox) alertBox.classList.add('hidden');

  submitBtn.disabled = true;
  submitText.classList.add('hidden');
  spinner.classList.remove('hidden');

  try {
    if (currentAuthTab === 'register') {
      const fullName = document.getElementById('auth-fullname').value.trim();
      const confirmPassword = document.getElementById('auth-confirm-password').value;

      if (!fullName) {
        throw new Error('অনুগ্রহ করে আপনার পুরো নাম লিখুন।');
      }

      if (password !== confirmPassword) {
        throw new Error('পাসওয়ার্ড এবং কনফার্ম পাসওয়ার্ড মিলছে না!');
      }

      const res = await window.authService.register({ fullName, phone, password });
      showAuthAlert(res.message || 'রেজিস্ট্রেশন সফল হয়েছে! অ্যাডমিন একটিভ করার পর লগইন করতে পারবেন।', 'success');
      showToast('রেজিস্ট্রেশন সফল হয়েছে!');

      // Clear password and switch to login tab
      document.getElementById('auth-password').value = '';
      document.getElementById('auth-confirm-password').value = '';
      setTimeout(() => {
        window.switchAuthTab('login');
      }, 2000);
    } else {
      const res = await window.authService.login({ phone, password });
      showToast('স্বাগতম! লগইন সফল হয়েছে।');
      const authModal = document.getElementById('auth-modal');
      if (authModal) authModal.classList.add('hidden');
    }
  } catch (err) {
    let msg = err.message || 'ত্রুটি ঘটেছে, পুনরায় চেষ্টা করুন।';
    if (err.code === 'ACCOUNT_INACTIVE') {
      showAuthAlert(`<strong style="display:block; margin-bottom:4px;">🔒 একাউন্ট ইনএকটিভ (Pending Approval)</strong>${msg}`, 'warning');
    } else if (err.code === 'DEVICE_MISMATCH' || err.code === 'SESSION_REVOKED') {
      showAuthAlert(`<strong style="display:block; margin-bottom:4px;">⚠️ অন্য ডিভাইসে সেশন সক্রিয়</strong>${msg}`, 'warning');
    } else {
      showAuthAlert(msg, 'error');
    }
  } finally {
    submitBtn.disabled = false;
    submitText.classList.remove('hidden');
    spinner.classList.add('hidden');
  }
};

window.handleLogout = function () {
  if (window.authService) {
    window.authService.logout();
    showToast('সফলভাবে লগআউট করা হয়েছে।');
  }
};

window.updateAuthUI = function (user) {
  const authModal = document.getElementById('auth-modal');
  const sidebarUserName = document.getElementById('sidebar-user-name');
  const sidebarUserStatus = document.getElementById('sidebar-user-status');
  const navAdmin = document.getElementById('nav-admin');

  if (user && user.is_active && !user.is_locked) {
    if (authModal) authModal.classList.add('hidden');
    if (sidebarUserName) sidebarUserName.innerText = user.full_name || user.phone;

    const isAdmin = user.is_admin === true;
    if (isAdmin) {
      if (sidebarUserStatus) sidebarUserStatus.innerHTML = '<i class="fa-solid fa-shield-halved" style="color:#c084fc;"></i> সিস্টেম অ্যাডমিন';
      if (navAdmin) navAdmin.classList.remove('hidden');
      loadAdminPendingCount();
    } else {
      if (sidebarUserStatus) sidebarUserStatus.innerHTML = '<i class="fa-solid fa-circle" style="color:#10b981;"></i> প্রিমিয়াম শিক্ষার্থী';
      if (navAdmin) navAdmin.classList.add('hidden');
    }

    // Auto-restore course or video if requested via URL
    const state = parseUrlState();
    if ((state.vid || state.courseIdx !== null) && !currentPlayingLec) {
      restoreStateFromUrl();
    }
  } else if (user && user.is_locked) {
    if (authModal) authModal.classList.remove('hidden');
    if (sidebarUserName) sidebarUserName.innerText = user.full_name || user.phone;
    if (sidebarUserStatus) sidebarUserStatus.innerHTML = '<i class="fa-solid fa-lock" style="color:#ef4444;"></i> একাউন্ট লকড';
    if (navAdmin) navAdmin.classList.add('hidden');
    window.showAuthAlert('<strong>🔒 আপনার একাউন্টটি সাময়িকভাবে লক করা হয়েছে।</strong><br>আপনি কোনো ভিডিও বা কোর্স এক্সেস করতে পারবেন না। অনুগ্রহ করে অ্যাডমিনের সাথে যোগাযোগ করুন।', 'error');
    if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
      try { ytPlayer.pauseVideo(); } catch (e) { }
    }
  } else {
    if (authModal) authModal.classList.remove('hidden');
    if (sidebarUserName) sidebarUserName.innerText = 'লগইন করা নেই';
    if (sidebarUserStatus) sidebarUserStatus.innerHTML = '<i class="fa-solid fa-circle" style="color:#ef4444;"></i> এক্সেস বন্ধ';
    if (navAdmin) navAdmin.classList.add('hidden');

    // Pause video if playing
    if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
      try { ytPlayer.pauseVideo(); } catch (e) { }
    }
  }
};

async function loadAdminPendingCount() {
  if (!window.authService || !window.authService.isAdmin()) return;
  try {
    const users = await window.authService.adminGetUsers();
    // Count both inactive (pending approval) AND locked accounts
    const pending = users.filter(u => !u.is_active || u.is_locked).length;
    const badge = document.getElementById('admin-pending-badge');
    if (badge) {
      badge.innerText = pending;
      if (pending > 0) badge.classList.remove('hidden');
      else badge.classList.add('hidden');
    }
  } catch (e) { }
}

// Initialize App
function initApp() {
  const courses = window.COURSES_DATA || [];
  totalCoursesCount.innerText = courses.length;
  const badgeEl = document.getElementById('sidebar-course-count');
  if (badgeEl) badgeEl.innerText = `${courses.length}টি কোর্স`;

  let grandTotalLecs = 0;
  courses.forEach(c => {
    const stats = getCourseStats(c);
    grandTotalLecs += stats.totalLecs;
  });
  totalLecturesCount.innerText = grandTotalLecs;

  updateBadges();
  renderSidebarCourses();
  renderHomeView();
  setupHtml5VideoEvents();

  // Initialize YouTube Player if API is already loaded in memory
  if (window.YT && window.YT.Player && !ytPlayer) {
    initYouTubePlayer();
  }

  // Restore active view, course, or video from URL hash upon reload
  restoreStateFromUrl();

  // Listen to browser Back / Forward buttons and Hash changes
  window.addEventListener('hashchange', restoreStateFromUrl);

  // Auth Initialization
  if (window.authService) {
    window.authService.onAuthStateChange(window.updateAuthUI);
  }

  // Mobile virtual keyboard scroll support for auth modal
  setupAuthInputScroll();
}

function setupAuthInputScroll() {
  const authInputs = document.querySelectorAll('#auth-form input');
  authInputs.forEach(input => {
    input.addEventListener('focus', () => {
      setTimeout(() => {
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 260);
    });
  });
}

function updateBadges() {
  if (bookmarkCount) bookmarkCount.innerText = bookmarkedLectures.length;
  if (watchedCount) watchedCount.innerText = watchHistory.length;
}

// View Switches
window.showHomeView = function (updateUrl = true) {
  closeMobileSidebar();
  if (updateUrl) setUrlState('home');
  navHome.classList.add('active');
  navBookmarks.classList.remove('active');
  navHistory.classList.remove('active');
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.classList.remove('active');

  viewHome.classList.remove('hidden');
  viewPlayer.classList.add('hidden');
  viewSearch.classList.add('hidden');
  const viewAdmin = document.getElementById('view-admin');
  if (viewAdmin) viewAdmin.classList.add('hidden');
};

function showPlayerView() {
  navHome.classList.remove('active');
  navBookmarks.classList.remove('active');
  navHistory.classList.remove('active');
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.classList.remove('active');

  viewHome.classList.add('hidden');
  viewPlayer.classList.remove('hidden');
  viewSearch.classList.add('hidden');
  const viewAdmin = document.getElementById('view-admin');
  if (viewAdmin) viewAdmin.classList.add('hidden');
}

window.showBookmarksView = function (updateUrl = true) {
  closeMobileSidebar();
  if (updateUrl) setUrlState('bookmarks');
  navHome.classList.remove('active');
  navBookmarks.classList.add('active');
  navHistory.classList.remove('active');
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.classList.remove('active');

  viewHome.classList.add('hidden');
  viewPlayer.classList.add('hidden');
  viewSearch.classList.remove('hidden');
  const viewAdmin = document.getElementById('view-admin');
  if (viewAdmin) viewAdmin.classList.add('hidden');

  document.getElementById('search-title').innerText = `বুকমার্ক করা ভিডিওসমূহ (${bookmarkedLectures.length})`;

  const resultsContainer = document.getElementById('search-results-list');
  resultsContainer.innerHTML = '';

  if (bookmarkedLectures.length === 0) {
    resultsContainer.innerHTML = `<p style="color: var(--text-muted); grid-column: 1/-1;">কোনো বুকমার্ক করা ভিডিও পাওয়া যায়নি।</p>`;
    return;
  }

  bookmarkedLectures.forEach(item => {
    const details = findLectureDetails(item.url) || {};
    const courseIdx = item.courseIdx !== undefined ? item.courseIdx : (item.courseIndex !== undefined ? item.courseIndex : (details.courseIdx !== undefined ? details.courseIdx : 0));
    const courseName = details.courseName || (window.COURSES_DATA && window.COURSES_DATA[courseIdx] ? window.COURSES_DATA[courseIdx].course_name : 'কোর্স');
    const chName = item.chName || item.chapterName || details.chName || 'অধ্যায়';
    const subName = item.subName || item.subDivName || details.subName || null;
    const lecTitle = item.lecTitle || item.lecture || details.lecTitle || 'লেকচার';
    const savedTime = getVideoProgress(item.url);

    const card = document.createElement('div');
    card.className = 'course-card';
    card.onclick = () => playSpecificLecture(courseIdx, chName, subName, item.url, lecTitle, savedTime, true, details.tg_url);
    card.innerHTML = `
      <div class="card-top-row">
        <div class="card-subject-icon"><i class="fa-solid fa-bookmark"></i></div>
        <span class="card-pill-tag">${escapeHtml(courseName)}</span>
      </div>
      <h4 class="course-card-title">${escapeHtml(lecTitle)} - ${escapeHtml(chName)}${subName ? ' (' + escapeHtml(subName) + ')' : ''}</h4>
      <div class="card-meta-footer">
        <div class="meta-stats-group">
          ${savedTime > 0 ? `<span><i class="fa-regular fa-clock"></i> ${formatDuration(savedTime)}-এ ছিল</span>` : `<span><i class="fa-regular fa-bookmark"></i> বুকমার্কড</span>`}
        </div>
        <span class="meta-play-btn"><i class="fa-solid fa-play"></i> প্লে করুন</span>
      </div>
    `;
    resultsContainer.appendChild(card);
  });
};

window.showHistoryView = function (updateUrl = true) {
  closeMobileSidebar();
  if (updateUrl) setUrlState('history');
  navHome.classList.remove('active');
  navBookmarks.classList.remove('active');
  navHistory.classList.add('active');
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.classList.remove('active');

  viewHome.classList.add('hidden');
  viewPlayer.classList.add('hidden');
  viewSearch.classList.remove('hidden');
  const viewAdmin = document.getElementById('view-admin');
  if (viewAdmin) viewAdmin.classList.add('hidden');

  document.getElementById('search-title').innerText = `ওয়াচ হিস্ট্রি (${watchHistory.length})`;

  const resultsContainer = document.getElementById('search-results-list');
  resultsContainer.innerHTML = '';

  if (watchHistory.length === 0) {
    resultsContainer.innerHTML = `<p style="color: var(--text-muted); grid-column: 1/-1;">কোনো ওয়াচ হিস্ট্রি পাওয়া যায়নি। কোনো ভিডিও প্লে করলে তা স্বয়ংক্রিয়ভাবে এখানে যুক্ত হবে।</p>`;
    return;
  }

  watchHistory.forEach(item => {
    const details = findLectureDetails(item.url) || {};
    const courseIdx = item.courseIdx !== undefined ? item.courseIdx : (item.courseIndex !== undefined ? item.courseIndex : (details.courseIdx !== undefined ? details.courseIdx : 0));
    const courseName = details.courseName || (window.COURSES_DATA && window.COURSES_DATA[courseIdx] ? window.COURSES_DATA[courseIdx].course_name : 'কোর্স');
    const chName = item.chName || item.chapterName || details.chName || 'অধ্যায়';
    const subName = item.subName !== undefined ? item.subName : (details.subName || null);
    const lecTitle = item.lecTitle || item.lecture || details.lecTitle || 'লেকচার';
    const savedTime = getVideoProgress(item.url) || item.progress || 0;
    const duration = item.duration || 0;

    const card = document.createElement('div');
    card.className = 'course-card';
    card.onclick = () => playSpecificLecture(courseIdx, chName, subName, item.url, lecTitle, savedTime, true, details.tg_url);
    card.innerHTML = `
      <div class="card-top-row">
        <div class="card-subject-icon" style="color: #38bdf8;"><i class="fa-solid fa-clock-rotate-left"></i></div>
        <span class="card-pill-tag" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8;">${escapeHtml(courseName)}</span>
      </div>
      <h4 class="course-card-title">${escapeHtml(lecTitle)} - ${escapeHtml(chName)}${subName ? ' (' + escapeHtml(subName) + ')' : ''}</h4>
      <div class="card-meta-footer">
        <div class="meta-stats-group">
          ${savedTime > 0 ? `<span><i class="fa-regular fa-clock"></i> ${formatDuration(savedTime)}${duration > 0 ? ' / ' + formatDuration(duration) : ''}</span>` : `<span><i class="fa-regular fa-clock"></i> সম্প্রতি প্লে করা</span>`}
        </div>
        <span class="meta-play-btn"><i class="fa-solid fa-play"></i> চালিয়ে যান</span>
      </div>
    `;
    resultsContainer.appendChild(card);
  });
};

// ========================================================
// ADMIN PANEL CONTROLLER
// ========================================================
let adminUsersList = [];
let currentAdminFilter = 'all';

window.showAdminView = function (updateUrl = true) {
  closeMobileSidebar();
  if (!window.authService || !window.authService.isAdmin()) {
    showToast('অ্যাডমিন অনুমতি নেই!');
    showHomeView();
    return;
  }
  if (updateUrl) setUrlState('admin');

  navHome.classList.remove('active');
  navBookmarks.classList.remove('active');
  navHistory.classList.remove('active');
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.classList.add('active');

  viewHome.classList.add('hidden');
  viewPlayer.classList.add('hidden');
  viewSearch.classList.add('hidden');
  const viewAdmin = document.getElementById('view-admin');
  if (viewAdmin) viewAdmin.classList.remove('hidden');

  loadAdminUsers();
};

window.loadAdminUsers = async function () {
  const container = document.getElementById('admin-users-list');
  if (!container) return;

  container.innerHTML = `
    <div class="admin-loading-placeholder">
      <i class="fa-solid fa-circle-notch fa-spin"></i>
      <span>ইউজার তালিকা লোড হচ্ছে...</span>
    </div>
  `;

  try {
    adminUsersList = await window.authService.adminGetUsers();
    updateAdminStats();
    renderAdminUserCards();
  } catch (err) {
    container.innerHTML = `
      <div class="admin-loading-placeholder" style="color:#ef4444;">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>${err.message || 'ডাটা লোড করা যায়নি'}</span>
      </div>
    `;
    showToast('ডাটা লোড ব্যর্থ হয়েছে');
  }
};

function updateAdminStats() {
  const total = adminUsersList.length;
  const pending = adminUsersList.filter(u => !u.is_active || u.is_locked).length;
  const active = adminUsersList.filter(u => u.is_active && !u.is_locked).length;
  const admins = adminUsersList.filter(u => u.is_admin).length;

  const elTotal = document.getElementById('stat-total-users');
  const elPending = document.getElementById('stat-pending-users');
  const elActive = document.getElementById('stat-active-users');
  const elAdmin = document.getElementById('stat-admin-users');
  const badgePending = document.getElementById('admin-pending-badge');

  if (elTotal) elTotal.innerText = total;
  if (elPending) elPending.innerText = pending;
  if (elActive) elActive.innerText = active;
  if (elAdmin) elAdmin.innerText = admins;

  if (badgePending) {
    badgePending.innerText = pending;
    if (pending > 0) badgePending.classList.remove('hidden');
    else badgePending.classList.add('hidden');
  }
}

window.setAdminFilter = function (filter, el) {
  currentAdminFilter = filter;
  document.querySelectorAll('.admin-chip').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  renderAdminUserCards();
};

window.filterAdminUsers = function () {
  renderAdminUserCards();
};

function renderAdminUserCards() {
  const container = document.getElementById('admin-users-list');
  const searchInput = document.getElementById('admin-user-search');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  if (!container) return;

  let filtered = adminUsersList.filter(u => {
    const isApproved = u.is_active && !u.is_locked;
    if (currentAdminFilter === 'pending' && isApproved) return false;
    if (currentAdminFilter === 'active' && !isApproved) return false;
    if (currentAdminFilter === 'admin' && !u.is_admin) return false;

    if (query) {
      const matchPhone = u.phone && u.phone.toLowerCase().includes(query);
      const matchName = u.full_name && u.full_name.toLowerCase().includes(query);
      return matchPhone || matchName;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="admin-loading-placeholder">
        <i class="fa-solid fa-user-slash"></i>
        <span>কোনো শিক্ষার্থী বা ইউজার পাওয়া যায়নি</span>
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  filtered.forEach(u => {
    const card = document.createElement('div');
    const isApproved = u.is_active && !u.is_locked;
    const isAdmin = u.is_admin === true;

    card.className = `admin-user-card ${!isApproved ? 'is-locked' : ''} ${isAdmin ? 'is-admin-card' : ''}`;

    const regDate = u.created_at ? new Date(u.created_at).toLocaleDateString('bn-BD') : 'অজানা';
    const lastActive = u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('bn-BD') : 'লগইন হয়নি';

    let avatarClass = 'user-card-avatar';
    let avatarIcon = 'fa-user-graduate';
    if (isAdmin) { avatarClass += ' admin-avatar'; avatarIcon = 'fa-shield-halved'; }
    else if (!isApproved) { avatarClass += ' locked-avatar'; avatarIcon = 'fa-user-lock'; }

    card.innerHTML = `
      <div class="user-card-info">
        <div class="${avatarClass}">
          <i class="fa-solid ${avatarIcon}"></i>
        </div>
        <div class="user-card-name-group">
          <span class="user-card-name">${escapeHtml(u.full_name || 'নাম নেই')}</span>
          <span class="user-card-phone"><i class="fa-solid fa-phone"></i> +88 ${u.phone}</span>
          <div class="user-card-badges">
            ${isAdmin ? '<span class="u-badge u-badge-admin"><i class="fa-solid fa-shield"></i> অ্যাডমিন</span>' : '<span class="u-badge u-badge-student"><i class="fa-solid fa-graduation-cap"></i> শিক্ষার্থী</span>'}
            ${isApproved ? '<span class="u-badge u-badge-active"><i class="fa-solid fa-check"></i> সক্রিয়</span>' : '<span class="u-badge u-badge-locked"><i class="fa-solid fa-lock"></i> লকড / পেন্ডিং</span>'}
          </div>
        </div>
      </div>

      <div class="user-card-meta">
        <span><i class="fa-regular fa-calendar"></i> রেজিস্টার্ড: ${regDate}</span>
        <span><i class="fa-regular fa-clock"></i> লাস্ট লগইন: ${lastActive}</span>
      </div>

      <div class="user-card-actions">
        <!-- 1. Single Approve / Lock Toggle Button -->
        ${isApproved ?
        `<button class="btn-card-action btn-act-lock" onclick="handleAdminToggleApproval('${u.id}', true)" title="একাউন্ট লক করুন (ভিডিও দেখা বন্ধ)"><i class="fa-solid fa-lock"></i> লক করুন</button>` :
        `<button class="btn-card-action btn-act-approve" onclick="handleAdminToggleApproval('${u.id}', false)" title="অনুমোদন দিয়ে একাউন্ট একটিভ করুন"><i class="fa-solid fa-circle-check"></i> অনুমোদন দিন</button>`
      }

        <!-- 2. Role Toggle Button -->
        <button class="btn-card-action btn-act-role" onclick="handleAdminToggleRole('${u.id}', ${isAdmin})" title="রোল পরিবর্তন করুন">
          <i class="fa-solid ${isAdmin ? 'fa-user-graduate' : 'fa-shield-halved'}"></i> ${isAdmin ? 'শিক্ষার্থী করুন' : 'অ্যাডমিন করুন'}
        </button>

        <!-- 3. Session Reset Button -->
        <button class="btn-card-action btn-act-reset" onclick="handleAdminResetDevice('${u.id}')" title="সেশন রিসেট করুন (ফোর্স লগআউট)">
          <i class="fa-solid fa-rotate-left"></i> সেশন রিসেট
        </button>

        <!-- 4. Delete User Button -->
        <button class="btn-card-action btn-act-delete" onclick="handleAdminDeleteUser('${u.id}')" title="ইউজার ডিলিট করুন">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    `;

    container.appendChild(card);
  });
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, function (m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
}

window.handleAdminToggleApproval = async function (userId, currentlyApproved) {
  const target = adminUsersList.find(u => u.id === userId);
  if (!target) return;
  const newActive = !currentlyApproved;

  try {
    await window.authService.adminUpdateUser(userId, {
      isActive: newActive,
      isAdmin: target.is_admin,
      isLocked: !newActive,
      resetDevice: false
    });
    target.is_active = newActive;
    target.is_locked = !newActive;
    showToast(newActive ? '✅ শিক্ষার্থী অনুমোদিত ও সক্রিয় হয়েছে!' : '🔒 একাউন্ট লক করা হয়েছে (ভিডিও বন্ধ)!');
    updateAdminStats();
    renderAdminUserCards();
  } catch (e) {
    showToast(e.message || 'আপডেট ফেইল্ড');
  }
};

window.handleAdminToggleRole = async function (userId, currentAdmin) {
  const target = adminUsersList.find(u => u.id === userId);
  if (!target) return;
  const newAdmin = !currentAdmin;

  if (!confirm(`আপনি কি এই ইউজারকে ${newAdmin ? 'অ্যাডমিন' : 'শিক্ষার্থী'} করতে চান?`)) return;

  try {
    await window.authService.adminUpdateUser(userId, {
      isActive: target.is_active,
      isAdmin: newAdmin,
      isLocked: target.is_locked,
      resetDevice: false
    });
    target.is_admin = newAdmin;
    showToast(newAdmin ? '🛡️ ইউজারকে অ্যাডমিন রোল দেওয়া হয়েছে!' : '🎓 ইউজারকে শিক্ষার্থী রোল দেওয়া হয়েছে!');
    updateAdminStats();
    renderAdminUserCards();
  } catch (e) {
    showToast(e.message || 'আপডেট ফেইল্ড');
  }
};

window.handleAdminResetDevice = async function (userId) {
  if (!confirm('আপনি কি এই ইউজারের সেশন ও ডিভাইস রিসেট করতে চান? এর ফলে যেকোনো সক্রিয় ডিভাইস থেকে ইউজার স্বয়ংক্রিয়ভাবে লগআউট হয়ে যাবে।')) return;

  const target = adminUsersList.find(u => u.id === userId);
  if (!target) return;

  try {
    await window.authService.adminUpdateUser(userId, {
      isActive: target.is_active,
      isAdmin: target.is_admin,
      isLocked: target.is_locked,
      resetDevice: true
    });
    showToast('সেশন সফলভাবে রিসেট করা হয়েছে!');
    renderAdminUserCards();
  } catch (e) {
    showToast(e.message || 'রিসেট ফেইল্ড');
  }
};

window.handleAdminDeleteUser = async function (userId) {
  if (!confirm('আপনি কি নিশ্চিতভাবে এই শিক্ষার্থীকে স্থায়ীভাবে ডিলিট করতে চান?')) return;

  try {
    await window.authService.adminDeleteUser(userId);
    adminUsersList = adminUsersList.filter(u => u.id !== userId);
    showToast('ইউজার ডিলিট করা হয়েছে!');
    updateAdminStats();
    renderAdminUserCards();
  } catch (e) {
    showToast(e.message || 'ডিলিট ফেইল্ড');
  }
};

// Render Sidebar Courses
function renderSidebarCourses() {
  const courses = window.COURSES_DATA || [];
  sidebarCoursesList.innerHTML = '';

  courses.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = `course-nav-btn ${idx === currentCourseIndex ? 'active' : ''}`;
    item.onclick = () => selectCourse(idx);

    const iconClass = getCourseIcon(c.course_name);
    item.innerHTML = `
      <i class="fa-solid ${iconClass} course-nav-icon"></i>
      <span class="course-nav-name">${c.course_name}</span>
    `;
    sidebarCoursesList.appendChild(item);
  });
}

// Render Home View Grid
function renderHomeView() {
  const courses = window.COURSES_DATA || [];
  courseGrid.innerHTML = '';

  courses.forEach((c, idx) => {
    const stats = getCourseStats(c);
    const iconClass = getCourseIcon(c.course_name);
    const card = document.createElement('div');
    card.className = 'course-card';
    card.onclick = () => selectCourse(idx);

    card.innerHTML = `
      <div class="card-top-row">
        <div class="card-subject-icon">
          <i class="fa-solid ${iconClass}"></i>
        </div>
        <span class="card-pill-tag">২০২৫-২৬ সেশন</span>
      </div>
      <h4 class="course-card-title">${c.course_name}</h4>
      <div class="card-meta-footer">
        <div class="meta-stats-group">
          <span><i class="fa-solid fa-folder-open"></i> ${stats.totalChaps} অধ্যায়</span>
          <span><i class="fa-solid fa-video"></i> ${stats.totalLecs} ক্লাস</span>
        </div>
        <span class="meta-play-btn"><i class="fa-solid fa-circle-play"></i> শুরু করুন</span>
      </div>
    `;
    courseGrid.appendChild(card);
  });
}

// Select Course & Render Player View
function selectCourse(courseIdx, updateUrl = true, autoPlayFirst = true, targetUrl = null) {
  closeMobileSidebar();
  if (window.authService && !window.authService.isLoggedIn()) {
    const authModal = document.getElementById('auth-modal');
    if (authModal) authModal.classList.remove('hidden');
    window.showAuthAlert('কোর্সের ভিডিও দেখতে প্রথমে আপনার ফোন নম্বর ও পাসওয়ার্ড দিয়ে লগইন করুন।', 'warning');
    return;
  }

  currentCourseIndex = courseIdx;
  const course = window.COURSES_DATA[courseIdx];
  if (!course) return;

  if (updateUrl && !targetUrl) {
    setUrlState('course', { course: courseIdx });
  }

  renderSidebarCourses();
  showPlayerView();

  playlistCourseTitle.innerText = course.course_name;
  const stats = getCourseStats(course);
  playlistSubtitle.innerText = `${stats.totalChaps} টি অধ্যায় • ${stats.totalLecs} টি ভিডিও লেকচার`;

  buildFlatPlaylist(course, courseIdx);
  renderPlaylistAccordion(course, courseIdx, autoPlayFirst, targetUrl);
  updateCourseProgress();
}

function buildFlatPlaylist(course, courseIdx) {
  currentPlaylistFlat = [];
  if (!course.chapters) return;

  for (const [chName, chVal] of Object.entries(course.chapters)) {
    if (Array.isArray(chVal)) {
      chVal.forEach(lec => {
        currentPlaylistFlat.push({ url: lec.url, tg_url: lec.tg_url, lecture: lec.lecture, chName, subName: null, courseIdx });
      });
    } else if (typeof chVal === 'object') {
      for (const [subName, subVal] of Object.entries(chVal)) {
        if (Array.isArray(subVal)) {
          subVal.forEach(lec => {
            currentPlaylistFlat.push({ url: lec.url, tg_url: lec.tg_url, lecture: lec.lecture, chName, subName, courseIdx });
          });
        }
      }
    }
  }
}

// Render Playlist Accordion
function renderPlaylistAccordion(course, courseIdx, autoPlayFirst = true, targetUrl = null) {
  playlistAccordionContainer.innerHTML = '';
  if (!course.chapters) return;

  let isFirstChapter = true;
  let firstVideo = null;

  for (const [chName, chVal] of Object.entries(course.chapters)) {
    // If targetUrl provided, check if this chapter contains it
    let chapterContainsTarget = false;
    if (targetUrl) {
      if (Array.isArray(chVal)) {
        chapterContainsTarget = chVal.some(lec => lec.url === targetUrl || (lec.tg_url && lec.tg_url === targetUrl));
      } else if (typeof chVal === 'object') {
        for (const subVal of Object.values(chVal)) {
          if (Array.isArray(subVal) && subVal.some(lec => lec.url === targetUrl || (lec.tg_url && lec.tg_url === targetUrl))) {
            chapterContainsTarget = true;
            break;
          }
        }
      }
    }

    const shouldBeOpen = targetUrl ? chapterContainsTarget : isFirstChapter;
    const chapAcc = document.createElement('div');
    chapAcc.className = `chapter-accordion ${shouldBeOpen ? 'open' : ''}`;

    const chapHeader = document.createElement('div');
    chapHeader.className = 'chapter-header';
    chapHeader.onclick = () => chapAcc.classList.toggle('open');
    chapHeader.innerHTML = `
      <div class="chapter-header-title">
        <i class="fa-solid fa-folder"></i>
        <span>${chName}</span>
      </div>
      <i class="fa-solid fa-chevron-down chevron-icon"></i>
    `;

    const chapBody = document.createElement('div');
    chapBody.className = 'chapter-body';

    if (Array.isArray(chVal)) {
      chVal.forEach((lec, lecIdx) => {
        const isWatched = watchHistory.some(w => w.url === lec.url);
        const lecItem = document.createElement('div');
        lecItem.className = `lecture-item ${isWatched ? 'completed' : ''} ${targetUrl === lec.url ? 'active' : ''}`;
        lecItem.dataset.url = lec.url;
        lecItem.onclick = () => playVideo(lec.url, lec.lecture, chName, null, courseIdx, null, true, lec.tg_url);
        
        const tgIcon = lec.tg_url ? `<i class="fa-brands fa-telegram" style="color: #38bdf8; margin-left: auto; font-size: 13px;" title="Telegram Stream"></i>` : '';
        lecItem.innerHTML = `
          <i class="fa-solid ${isWatched ? 'fa-circle-check' : 'fa-circle-play'} play-icon"></i>
          <span class="lecture-info">${lec.lecture}</span>
          ${tgIcon}
        `;
        chapBody.appendChild(lecItem);

        if (isFirstChapter && lecIdx === 0) {
          firstVideo = { url: lec.url, tg_url: lec.tg_url, title: lec.lecture, chName, subName: null };
        }
      });
    } else if (typeof chVal === 'object') {
      for (const [subName, subVal] of Object.entries(chVal)) {
        const subBlock = document.createElement('div');
        subBlock.className = 'subdiv-block';
        subBlock.innerHTML = `<div class="subdiv-title"><i class="fa-solid fa-layer-group"></i> ${subName}</div>`;

        if (Array.isArray(subVal)) {
          subVal.forEach((lec, lecIdx) => {
            const isWatched = watchHistory.some(w => w.url === lec.url);
            const lecItem = document.createElement('div');
            lecItem.className = `lecture-item ${isWatched ? 'completed' : ''} ${targetUrl === lec.url ? 'active' : ''}`;
            lecItem.dataset.url = lec.url;
            lecItem.onclick = () => playVideo(lec.url, lec.lecture, chName, subName, courseIdx, null, true, lec.tg_url);
            
            const tgIcon = lec.tg_url ? `<i class="fa-brands fa-telegram" style="color: #38bdf8; margin-left: auto; font-size: 13px;" title="Telegram Stream"></i>` : '';
            lecItem.innerHTML = `
              <i class="fa-solid ${isWatched ? 'fa-circle-check' : 'fa-circle-play'} play-icon"></i>
              <span class="lecture-info">${lec.lecture}</span>
              ${tgIcon}
            `;
            subBlock.appendChild(lecItem);

            if (isFirstChapter && !firstVideo) {
              firstVideo = { url: lec.url, tg_url: lec.tg_url, title: lec.lecture, chName, subName };
            }
          });
        }
        chapBody.appendChild(subBlock);
      }
    }

    chapAcc.appendChild(chapHeader);
    chapAcc.appendChild(chapBody);
    playlistAccordionContainer.appendChild(chapAcc);

    isFirstChapter = false;
  }

  if (autoPlayFirst && firstVideo && !targetUrl) {
    playVideo(firstVideo.url, firstVideo.title, firstVideo.chName, firstVideo.subName, courseIdx, null, true, firstVideo.tg_url);
  }
}

// Play Video
function playVideo(url, lecTitle, chName, subName, courseIdx, targetTimestamp = null, updateUrl = true, tgUrl = null) {
  if (window.authService) {
    if (!window.authService.isLoggedIn()) {
      const authModal = document.getElementById('auth-modal');
      if (authModal) authModal.classList.remove('hidden');
      window.showAuthAlert('ভিডিও দেখতে প্রথমে আপনার একাউন্টে লগইন করুন।', 'warning');
      return;
    }
    // Pre-flight check active session on server
    window.authService.checkActiveSession();
  }

  // Robustly resolve details if missing
  const details = findLectureDetails(url) || {};
  if (courseIdx === undefined || courseIdx === null) courseIdx = details.courseIdx !== undefined ? details.courseIdx : 0;
  if (!lecTitle) lecTitle = details.lecTitle || 'লেকচার';
  if (!chName) chName = details.chName || 'অধ্যায়';
  if (subName === undefined) subName = details.subName || null;
  if (!tgUrl) tgUrl = details.tg_url || null;

  currentPlayingLec = { url, tg_url: tgUrl, lecTitle, chName, subName, courseIdx };
  currentPlaylistIndex = currentPlaylistFlat.findIndex(item => item.url === url || (item.tg_url && item.tg_url === tgUrl));

  const ytId = extractYouTubeId(url);
  if (updateUrl && ytId) {
    setUrlState('course', { c: courseIdx, v: ytId });
  }

  // Record into Watch History
  recordWatchHistory({ url, lecTitle, chName, subName, courseIdx });

  videoPlaceholder.classList.add('hidden');

  const course = window.COURSES_DATA && window.COURSES_DATA[courseIdx] ? window.COURSES_DATA[courseIdx] : null;
  const fullTitle = `${lecTitle} - ${chName}${subName ? ' (' + subName + ')' : ''}`;

  playerCoursePill.innerHTML = `<i class="fa-solid ${getCourseIcon(course ? course.course_name : '')}"></i> ${course ? course.course_name : ''}`;
  playerChapterText.innerText = `${chName} ${subName ? '> ' + subName : ''}`;
  playerVideoTitle.innerText = fullTitle;
  overlayVideoTitle.innerText = `${course ? course.course_name : ''} | ${fullTitle}`;

  // Determine starting timestamp
  let seekTime = 0;
  if (typeof targetTimestamp === 'number' && targetTimestamp > 0) {
    seekTime = targetTimestamp;
  } else {
    seekTime = getVideoProgress(url);
  }

  const v = document.getElementById('html5-video-player');
  const ytW = document.getElementById('yt-embed-wrapper');

  if (tgUrl) {
    // 🚀 STREAM VIA TELEGRAM BOT BACKEND
    currentStreamMode = 'telegram';
    if (playerStreamBadge) {
      playerStreamBadge.innerHTML = '<i class="fa-brands fa-telegram" style="color:#38bdf8;"></i> Telegram Stream';
    }

    if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
      try { ytPlayer.pauseVideo(); } catch (e) { }
    }
    if (ytW) ytW.classList.add('hidden');

    if (v) {
      v.classList.remove('hidden');
      const streamUrl = getStreamApiUrl(tgUrl);
      if (v.src !== streamUrl) {
        v.src = streamUrl;
      }
      if (seekTime > 0) {
        v.currentTime = seekTime;
      }
      v.play().catch(e => {
        console.warn("Autoplay blocked or stream connecting...", e);
      });
    }

    if (seekTime > 5) {
      showToast(`পূর্বের টাইমস্ট্যাম্প (${formatDuration(seekTime)}) থেকে শুরু হচ্ছে...`);
    }
  } else if (ytId) {
    // 🎬 FALLBACK TO YOUTUBE PLAYER
    switchToYouTube(url, seekTime);
    if (seekTime > 5) {
      showToast(`পূর্বের টাইমস্ট্যাম্প (${formatDuration(seekTime)}) থেকে শুরু হচ্ছে...`);
    }
  } else {
    showToast("ভিডিও লিংক পাওয়া যায়নি");
  }

  // Highlight active item
  document.querySelectorAll('.lecture-item').forEach(el => {
    if (el.dataset.url === url) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  // Update Bookmark state
  const isBookmarked = bookmarkedLectures.some(b => b.url === url);
  const bookmarkIcon = document.getElementById('bookmark-btn-icon');
  if (bookmarkIcon) {
    if (isBookmarked) {
      bookmarkIcon.className = 'fa-solid fa-bookmark';
      bookmarkIcon.style.color = '#818cf8';
    } else {
      bookmarkIcon.className = 'fa-regular fa-bookmark';
      bookmarkIcon.style.color = '';
    }
  }
}

// Next & Previous Navigation
window.playNextLecture = function () {
  if (currentPlaylistIndex < currentPlaylistFlat.length - 1) {
    const next = currentPlaylistFlat[currentPlaylistIndex + 1];
    playVideo(next.url, next.lecture, next.chName, next.subName, next.courseIdx, null, true, next.tg_url);
    showToast("পরবর্তী লেকচার প্লে হচ্ছে...");
  } else {
    showToast("এই কোর্সের শেষ লেকচারে পৌঁছে গেছেন!");
  }
};

window.playPreviousLecture = function () {
  if (currentPlaylistIndex > 0) {
    const prev = currentPlaylistFlat[currentPlaylistIndex - 1];
    playVideo(prev.url, prev.lecture, prev.chName, prev.subName, prev.courseIdx, null, true, prev.tg_url);
    showToast("পূর্ববর্তী লেকচার প্লে হচ্ছে...");
  } else {
    showToast("এটি প্রথম লেকচার!");
  }
};

function playSpecificLecture(courseIdx, chName, subName, url, lecTitle, timestamp = null, updateUrl = true, tgUrl = null) {
  if (window.authService && !window.authService.isLoggedIn()) {
    const authModal = document.getElementById('auth-modal');
    if (authModal) authModal.classList.remove('hidden');
    window.showAuthAlert('ভিডিও দেখতে প্রথমে আপনার একাউন্টে লগইন করুন।', 'warning');
    return;
  }

  // Robustly resolve details if any is missing/undefined
  if (courseIdx === undefined || courseIdx === null || !window.COURSES_DATA || !window.COURSES_DATA[courseIdx]) {
    const resolved = findLectureDetails(url);
    if (resolved) {
      courseIdx = resolved.courseIdx;
      chName = resolved.chName;
      subName = resolved.subName;
      lecTitle = resolved.lecTitle;
      if (!tgUrl) tgUrl = resolved.tg_url;
    } else {
      courseIdx = 0;
    }
  }

  selectCourse(courseIdx, false, false, url);
  playVideo(url, lecTitle, chName, subName, courseIdx, timestamp, updateUrl, tgUrl);
}

// Mark Current Video as Watched
window.markCurrentAsWatched = function () {
  if (!currentPlayingLec) return;

  const details = findLectureDetails(currentPlayingLec.url) || {};
  const itemToStore = {
    url: currentPlayingLec.url,
    lecTitle: currentPlayingLec.lecTitle || details.lecTitle || 'লেকচার',
    chName: currentPlayingLec.chName || details.chName || '',
    subName: currentPlayingLec.subName !== undefined ? currentPlayingLec.subName : (details.subName || null),
    courseIdx: currentPlayingLec.courseIdx !== undefined ? currentPlayingLec.courseIdx : (details.courseIdx !== undefined ? details.courseIdx : 0)
  };

  const existingIdx = watchedLectures.findIndex(w => w.url === currentPlayingLec.url);
  if (existingIdx === -1) {
    watchedLectures.push(itemToStore);
    localStorage.setItem('watched_lectures', JSON.stringify(watchedLectures));
    updateBadges();
    updateCourseProgress();
    showToast("লেকচার চিহ্নিত করা হয়েছে (Watched)!");

    document.querySelectorAll('.lecture-item').forEach(el => {
      if (el.dataset.url === currentPlayingLec.url) {
        el.classList.add('completed');
        const icon = el.querySelector('.play-icon');
        if (icon) icon.className = 'fa-solid fa-circle-check play-icon';
      }
    });
  } else {
    watchedLectures[existingIdx] = itemToStore;
    localStorage.setItem('watched_lectures', JSON.stringify(watchedLectures));
    showToast("লেকচারটি ইতোমধ্যে দেখা হয়েছে!");
  }
};

function updateCourseProgress() {
  if (currentPlaylistFlat.length === 0) return;
  let count = 0;
  currentPlaylistFlat.forEach(item => {
    if (watchedLectures.some(w => w.url === item.url)) count++;
  });
  const pct = Math.round((count / currentPlaylistFlat.length) * 100);
  if (courseProgressText) courseProgressText.innerText = `${pct}%`;
}

// Toggle Bookmark
window.toggleBookmarkCurrent = function () {
  if (!currentPlayingLec) return;

  const idx = bookmarkedLectures.findIndex(b => b.url === currentPlayingLec.url);
  if (idx >= 0) {
    bookmarkedLectures.splice(idx, 1);
    showToast("বুকমার্ক রিমুভ করা হয়েছে!");
  } else {
    const details = findLectureDetails(currentPlayingLec.url) || {};
    const itemToStore = {
      url: currentPlayingLec.url,
      lecTitle: currentPlayingLec.lecTitle || details.lecTitle || 'লেকচার',
      chName: currentPlayingLec.chName || details.chName || '',
      subName: currentPlayingLec.subName !== undefined ? currentPlayingLec.subName : (details.subName || null),
      courseIdx: currentPlayingLec.courseIdx !== undefined ? currentPlayingLec.courseIdx : (details.courseIdx !== undefined ? details.courseIdx : 0)
    };
    bookmarkedLectures.push(itemToStore);
    showToast("বুকমার্ক সংরক্ষণ করা হয়েছে!");
  }

  localStorage.setItem('bookmarked_lectures', JSON.stringify(bookmarkedLectures));
  updateBadges();

  const bookmarkIcon = document.getElementById('bookmark-btn-icon');
  if (bookmarkIcon) {
    if (idx >= 0) {
      bookmarkIcon.className = 'fa-regular fa-bookmark';
      bookmarkIcon.style.color = '';
    } else {
      bookmarkIcon.className = 'fa-solid fa-bookmark';
      bookmarkIcon.style.color = '#818cf8';
    }
  }
};

// Global Search
window.handleGlobalSearch = function () {
  const query = document.getElementById('global-search').value.toLowerCase().trim();

  if (!query) {
    showHomeView();
    return;
  }

  navHome.classList.remove('active');
  navBookmarks.classList.remove('active');
  navHistory.classList.remove('active');

  viewHome.classList.add('hidden');
  viewPlayer.classList.add('hidden');
  viewSearch.classList.remove('hidden');

  document.getElementById('search-title').innerText = `"${query}" এর জন্য অনুসন্ধান ফলাফল`;

  const resultsContainer = document.getElementById('search-results-list');
  resultsContainer.innerHTML = '';

  const courses = window.COURSES_DATA || [];
  let matchCount = 0;

  courses.forEach((c, cIdx) => {
    if (c.chapters) {
      for (const [chName, chVal] of Object.entries(c.chapters)) {
        if (Array.isArray(chVal)) {
          chVal.forEach(lec => {
            if (lec.lecture.toLowerCase().includes(query) || chName.toLowerCase().includes(query) || c.course_name.toLowerCase().includes(query)) {
              matchCount++;
              appendSearchResult(cIdx, c.course_name, chName, null, lec);
            }
          });
        } else if (typeof chVal === 'object') {
          for (const [subName, subVal] of Object.entries(chVal)) {
            if (Array.isArray(subVal)) {
              subVal.forEach(lec => {
                if (lec.lecture.toLowerCase().includes(query) || subName.toLowerCase().includes(query) || chName.toLowerCase().includes(query) || c.course_name.toLowerCase().includes(query)) {
                  matchCount++;
                  appendSearchResult(cIdx, c.course_name, chName, subName, lec);
                }
              });
            }
          }
        }
      }
    }
  });

  if (matchCount === 0) {
    resultsContainer.innerHTML = `<p style="color: var(--text-muted); grid-column: 1/-1;">কোনো ক্লাস বা লেকচার পাওয়া যায়নি।</p>`;
  }
};

function appendSearchResult(cIdx, courseName, chName, subName, lec) {
  const resultsContainer = document.getElementById('search-results-list');
  const card = document.createElement('div');
  card.className = 'course-card';
  card.onclick = () => playSpecificLecture(cIdx, chName, subName, lec.url, lec.lecture);

  card.innerHTML = `
    <div class="card-top-row">
      <div class="card-subject-icon"><i class="fa-solid fa-play"></i></div>
      <span class="card-pill-tag">${courseName}</span>
    </div>
    <h4 class="course-card-title">${lec.lecture} - ${chName} ${subName ? '(' + subName + ')' : ''}</h4>
    <div class="card-meta-footer">
      <span class="meta-play-btn"><i class="fa-solid fa-circle-play"></i> প্লে করতে ক্লিক করুন</span>
    </div>
  `;
  resultsContainer.appendChild(card);
}

window.addEventListener('beforeunload', () => {
  if (ytPlayer && isYtReady && currentPlayingLec && typeof ytPlayer.getCurrentTime === 'function') {
    const current = ytPlayer.getCurrentTime() || 0;
    if (current > 2) {
      saveVideoProgress(currentPlayingLec.url, current);
    }
  }
});

window.addEventListener('DOMContentLoaded', initApp);
