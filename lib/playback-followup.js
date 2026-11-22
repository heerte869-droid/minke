import {randomUUID} from 'node:crypto';

// One short-lived, read-only follow-up for the active browser share. Playback
// evidence belongs to its requesting session, connection, tab and exact URL.
export class PlaybackFollowup {
  #watch;
  #timer;
  #limit;
  #controller;
  #detach;

  get checking() { return this.#watch?.receipt.status === 'checking'; }

  get(key) {
    if (this.#watch?.key !== key) return undefined;
    return structuredClone(this.#watch.receipt);
  }

  // A direct model read and the timer can overlap. Only accept a reading for
  // the watch it started under, and never let an older read overwrite a newer one.
  beginSample(key) {
    const watch=this.#watch;
    if (!watch || watch.key!==key || watch.receipt.status!=='checking') return null;
    const order=++watch.started;
    return sample=>{
      if (this.#watch!==watch || watch.receipt.status!=='checking' || order<=watch.accepted) return;
      watch.accepted=order;
      watch.receive(sample);
    };
  }

  clear() {
    clearTimeout(this.#timer);
    clearTimeout(this.#limit);
    this.#detach?.();
    this.#detach = undefined;
    this.#watch = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
  }

  start(key, probe, {durationMs = 120000, intervalMs = 3000, parentSignal, requireMuted = false} = {}) {
    this.clear();
    const receipt = {id:randomUUID(), status:'checking', until:Date.now()+durationMs,
      samples:0, verifiedSamples:0, latest:null, lastVerified:null, background:null, backgroundPause:null, viewedAfterBackground:null};
    const watch = {key, receipt, started:0, accepted:0};
    this.#watch = watch;
    const controller = new AbortController();
    this.#controller = controller;

    const finish = reason => {
      if (this.#watch !== watch || receipt.status !== 'checking') return;
      receipt.status = 'finished';
      receipt.reason = reason;
      clearTimeout(this.#timer);
      clearTimeout(this.#limit);
      this.#detach?.();
      this.#detach = undefined;
      controller.abort();
    };
    const cancelled = () => finish('cancelled');
    watch.receive=sample=>{
      if (Date.now()>=receipt.until) { finish('time_limit'); return; }
      const playerId=receipt.lastVerified?.playerId;
      if (playerId && sample.playerId!==playerId) { finish('player_changed'); return; }
      if (requireMuted && (sample.muted!==true||sample.silenceVerified===false) && sample.verified) sample={...sample,verified:false};
      receipt.samples++;
      receipt.latest=sample;
      const hidden=sample.selectedBefore===false && sample.selectedAfter===false && sample.visibility==='hidden';
      if (hidden && sample.paused && receipt.background?.playerId && sample.playerId===receipt.background.playerId) {
        receipt.backgroundPause=sample;
      }
      if (!sample.verified) return;
      receipt.verifiedSamples++;
      receipt.lastVerified=sample;
      if (hidden) {
        receipt.background=sample;
      } else if (receipt.background?.playerId && sample.playerId===receipt.background.playerId &&
                 sample.selectedBefore===true && sample.selectedAfter===true && sample.visibility==='visible' &&
                 sample.from>=receipt.background.to) {
        receipt.viewedAfterBackground=sample;
        finish('viewed_after_background');
      }
    };
    parentSignal?.addEventListener('abort', cancelled, {once:true});
    this.#detach = () => parentSignal?.removeEventListener('abort', cancelled);
    if (parentSignal?.aborted) {
      cancelled();
      return this.get(key);
    }
    let failedReads = 0;
    const tick = async () => {
      if (this.#watch !== watch || controller.signal.aborted) return;
      try {
        const accept=this.beginSample(key);
        const sample = await probe(controller.signal);
        if (this.#watch !== watch || controller.signal.aborted) return;
        if (Date.now() >= receipt.until) { finish('time_limit'); return; }
        if (sample) {
          failedReads = 0;
          accept?.(sample);
        }
      } catch (error) {
        // Never retry an input: the probe contract permits only media reads.
        const transient = ['extension_timeout','extension_refused'].includes(error.code);
        if (!transient || ++failedReads >= 2) {
          finish(error.code === 'followup_target_changed' ? 'target_changed' : 'read_unavailable');
          return;
        }
      }
      if (this.#watch === watch && !controller.signal.aborted) {
        this.#timer = setTimeout(tick, intervalMs);
        this.#timer.unref?.();
      }
    };
    this.#limit = setTimeout(()=>finish('time_limit'), durationMs);
    this.#limit.unref?.();
    this.#timer = setTimeout(tick, 0);
    this.#timer.unref?.();
    return this.get(key);
  }
}
