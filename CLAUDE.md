Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Profanity Muter — Chrome Extension Plan

 Context

 Build a SponsorBlock-style Chrome extension that mutes YouTube audio during profanity. The extension already has a skeleton (Manifest V3, content script that extracts caption
 track URLs, categorized bad_words.json). The core muting logic is not yet implemented.

 This plan covers Phase 1 (local transcript-based muting) and outlines Phases 2–4 for future reference.

 ---
 Stack

 ┌─────────────────┬───────────────────────────────────────────────────┐
 │      Layer      │                    Technology                     │
 ├─────────────────┼───────────────────────────────────────────────────┤
 │ Extension       │ Chrome Manifest V3 (already set up)               │
 ├─────────────────┼───────────────────────────────────────────────────┤
 │ Caption parsing │ YouTube TimedText API (XML → word timestamps)     │
 ├─────────────────┼───────────────────────────────────────────────────┤
 │ Audio control   │ HTMLMediaElement / HTMLVideoElement.muted         │
 ├─────────────────┼───────────────────────────────────────────────────┤
 │ Storage         │ chrome.storage.local (user prefs, severity level) │
 ├─────────────────┼───────────────────────────────────────────────────┤
 │ Phase 2 DB      │ Supabase (Postgres + REST)                        │
 ├─────────────────┼───────────────────────────────────────────────────┤
 │ Phase 3 ASR     │ Whisper.cpp via WASM (or Transformers.js)         │
 ├─────────────────┼───────────────────────────────────────────────────┤
 │ UI              │ Minimal popup + injected toggle                   │
 └─────────────────┴───────────────────────────────────────────────────┘

 ---
 Difficulty Assessment

 ┌─────────────────────────┬─────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │          Phase          │ Difficulty  │                                                              Notes                                                               │
 ├─────────────────────────┼─────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
 │ 1 — Transcript muting   │ Medium      │ Main challenge: YouTube's timed-text XML gives per-segment timestamps, not always per-word. Need to estimate word timing within  │
 │                         │             │ segments.                                                                                                                        │
 ├─────────────────────────┼─────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
 │ 2 — Supabase storage    │ Easy–Medium │ CRUD + auth, straightforward                                                                                                     │
 ├─────────────────────────┼─────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
 │ 3 — In-browser ASR      │ Hard        │ WASM model loading, memory, latency                                                                                              │
 ├─────────────────────────┼─────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
 │ 4 — Community           │ Medium      │ UX + conflict resolution logic                                                                                                   │
 │ corrections             │             │                                                                                                                                  │
 └─────────────────────────┴─────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

 ---
 Phase 1 — Implementation Plan

 1. Fetch & Parse Captions (lib/captions.js)

 - Use the caption track URL already extracted by getEnglishCaptionTrack() in content.js
 - Fetch the TimedText XML (append &fmt=json3 for word-level timing when available)
 - Parse into a flat array: [{ word, startMs, endMs }]
 - Prefer json3 format (has wSubSeg word-level segments); fall back to XML with linear interpolation within each segment

 2. Build Mute Schedule (lib/matcher.js)

 - Load bad_words.json (filter by user-selected severity: 13+, 18+, slurs)
 - For each word in the transcript, check membership in the active bad-words set (case-insensitive, strip punctuation)
 - Produce a mute schedule: [{ startMs, endMs }]
 - Merge overlapping/adjacent intervals (within 100ms buffer)

 3. Audio Muting Engine (lib/muter.js)

 - Attach to the <video> element on the YouTube page
 - Use requestAnimationFrame loop (or timeupdate event) to check current playback time against the mute schedule
 - Set video.muted = true when inside a mute interval, restore when outside
 - Handle seek events: binary-search the schedule for the new position
 - Preserve user's manual mute state (don't unmute if user muted independently)

 4. Content Script Integration (content.js)

 - On page load / SPA navigation:
   a. Extract caption track URL (existing code)
   b. Fetch & parse captions
   c. Build mute schedule
   d. Start muting engine
 - Clean up on navigation away

 5. Popup UI (popup.html + popup.js)

 - Toggle extension on/off
 - Severity level selector (13+ / 18+ / slurs — checkboxes)
 - Status indicator (muting active / inactive)
 - Save prefs to chrome.storage.local

 6. Background Service Worker (background.js)

 - Keep existing toggle message
 - Add listener for popup state queries

 ---
 Key Files to Create/Modify

 ┌─────────────────┬─────────────────────────────────────────────────────────┐
 │      File       │                         Action                          │
 ├─────────────────┼─────────────────────────────────────────────────────────┤
 │ content.js      │ Rewrite: orchestrate caption fetch → schedule → mute    │
 ├─────────────────┼─────────────────────────────────────────────────────────┤
 │ lib/captions.js │ New: fetch & parse YouTube timed text                   │
 ├─────────────────┼─────────────────────────────────────────────────────────┤
 │ lib/matcher.js  │ New: bad-word matching + interval generation            │
 ├─────────────────┼─────────────────────────────────────────────────────────┤
 │ lib/muter.js    │ New: real-time audio muting engine                      │
 ├─────────────────┼─────────────────────────────────────────────────────────┤
 │ popup.html      │ New: settings UI                                        │
 ├─────────────────┼─────────────────────────────────────────────────────────┤
 │ popup.js        │ New: popup logic                                        │
 ├─────────────────┼─────────────────────────────────────────────────────────┤
 │ background.js   │ Minor update                                            │
 ├─────────────────┼─────────────────────────────────────────────────────────┤
 │ manifest.json   │ Add action.default_popup, possibly scripting permission │
 └─────────────────┴─────────────────────────────────────────────────────────┘

 ---
 Phases 2–4 (Future, not implemented now)

 Phase 2 — Supabase Backend

 - Store { videoId, wordTimestamps[] } in Supabase
 - On video load: check DB first → use cached timestamps if available
 - After local processing: upload results

 Phase 3 — In-Browser ASR

 - Bundle Whisper WASM (tiny model ~40MB)
 - User opt-in for compute
 - Process audio when no transcript available
 - Upload results to shared DB

 Phase 4 — Community Corrections

 - "Dislike" button on false positives
 - "Add" button to flag missed spots
 - Trigger ASR re-processing for flagged segments
 - Consensus mechanism before updating shared DB

 ---
 Verification (Phase 1)

 1. Load extension in chrome://extensions (developer mode)
 2. Navigate to a YouTube video with auto-generated English captions
 3. Confirm captions are fetched (check devtools console)
 4. Confirm audio mutes during profane words and unmutes after
 5. Test seek behavior (jump to a muted section, jump away)
 6. Test SPA navigation (click another video, verify re-initialization)
 7. Test popup: toggle severity levels, verify schedule updates