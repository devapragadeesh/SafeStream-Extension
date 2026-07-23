(function () {
    'use strict';

    class Muter {
        constructor(video, schedule) {
            this._video = video;
            this._schedule = schedule;
            this._rafId = null;
            this._userMuted = video.muted;
            this._extensionMuted = false;

            this._onVolumeChange = () => {
                if (!this._extensionMuted) {
                    this._userMuted = this._video.muted;
                }
            };
            this._video.addEventListener('volumechange', this._onVolumeChange);
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
            if (this._extensionMuted) {
                this._video.muted = this._userMuted;
                this._extensionMuted = false;
            }
        }

        updateSchedule(schedule) {
            this._schedule = schedule;
        }

        _tick() {
            this._rafId = requestAnimationFrame(() => this._tick());

            const nowMs = this._video.currentTime * 1000;
            const shouldMute = this._isInMuteZone(nowMs);

            if (shouldMute && !this._extensionMuted) {
                this._userMuted = this._video.muted;
                this._video.muted = true;
                this._extensionMuted = true;
            } else if (!shouldMute && this._extensionMuted) {
                this._video.muted = this._userMuted;
                this._extensionMuted = false;
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
