(function () {
    'use strict';

    class Muter {
        constructor(video, schedule) {
            this._video = video;
            this._schedule = schedule;
            this._rafId = null;
            this._userVolume = video.volume;
            this._silencing = false;
            // YouTube plays ads through this same <video> element on the ad's own
            // timeline, so our content-timeline mute schedule would otherwise fire
            // at random moments during an ad. The player container toggles an
            // 'ad-showing' class during ad playback — we skip muting while it's set.
            this._player = video.closest('.html5-video-player');

            // Setting video.muted = true is unreliable on YouTube: its own player
            // periodically reconciles the media element's muted state against its
            // volume-button UI state and silently flips an externally-set true back
            // to false within a couple hundred ms — even when set from the page's
            // own JS context. video.volume does not get fought the same way, so we
            // silence by zeroing volume instead and restore the user's prior volume
            // level afterward. This also composes correctly with a genuine manual
            // mute: if the user has muted via YouTube's UI, .muted keeps audio
            // silent regardless of what we do to volume.
            this._onVolumeChange = () => {
                if (!this._silencing) {
                    this._userVolume = this._video.volume;
                }
            };
            this._video.addEventListener('volumechange', this._onVolumeChange);

            // requestAnimationFrame is suspended by the browser whenever the tab is
            // backgrounded/hidden, which would silently stop all muting the moment the
            // user switches tabs. 'timeupdate' fires based on media playback, not
            // rendering, so it keeps working regardless of tab visibility — use it as
            // the primary driver. rAF is layered on top only for smoother foreground precision.
            this._onTimeUpdate = () => this._evaluate();
            this._video.addEventListener('timeupdate', this._onTimeUpdate);
        }

        start() {
            this._tick();
        }

        destroy() {
            if (this._rafId !== null) {
                cancelAnimationFrame(this._rafId);
                this._rafId = null;
            }
            this._video.removeEventListener('volumechange', this._onVolumeChange);
            this._video.removeEventListener('timeupdate', this._onTimeUpdate);
            if (this._silencing) {
                this._video.volume = this._userVolume;
                this._silencing = false;
            }
        }

        updateSchedule(schedule) {
            this._schedule = schedule;
        }

        _tick() {
            this._rafId = requestAnimationFrame(() => this._tick());
            this._evaluate();
        }

        _evaluate() {
            const nowMs = this._video.currentTime * 1000;
            const adShowing = this._player?.classList.contains('ad-showing');
            const shouldMute = !adShowing && this._isInMuteZone(nowMs);

            if (shouldMute) {
                if (!this._silencing) {
                    this._userVolume = this._video.volume;
                    this._silencing = true;
                }
                if (this._video.volume !== 0) this._video.volume = 0;
            } else if (this._silencing) {
                this._video.volume = this._userVolume;
                this._silencing = false;
            }
        }

        _isInMuteZone(nowMs) {
            const s = this._schedule;
            let lo = 0, hi = s.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (s[mid].startMs <= nowMs) lo = mid + 1;
                else hi = mid - 1;
            }
            const idx = lo - 1;
            if (idx < 0) return false;
            return nowMs < s[idx].endMs;
        }
    }

    window.ProfanityMuter = window.ProfanityMuter || {};
    window.ProfanityMuter.Muter = Muter;
})();
