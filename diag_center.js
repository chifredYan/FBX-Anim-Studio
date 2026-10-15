(async () => {
  const A = window.__app, S = A.S;
  document.querySelector('.sw[data-bg=alpha]').click();
  document.getElementById('exp-res').value = '1024';
  A.setZoom(0.6);
  S.centerLock = true;
  const W = 1024, H = 1024;

  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  async function shot(f, rig) {
    const r = A.renderFrameAt(f, W, H, true, rig);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = r.dataURL; });
    ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    let sx = 0, sy = 0, n = 0, minX = 1e9, maxX = -1;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 128) { const p = i / 4, x = p % W; sx += x; sy += (p / W) | 0; n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
    return { cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1), px: n,
      bboxX: [minX, maxX], cam: r.camPos.toArray().map(v => +v.toFixed(4)) };
  }

  const out = {};
  out.cfg = { zoom: S.zoom, std: +A.stdDistance().toFixed(3), expD: +A.exportDistance().toFixed(3),
    centerLock: S.centerLock, inPlace: S.inPlace, frames: S.frameCount };
  out.f0_noRig = await shot(0, null);
  const rig = A.calibrateExportRig(W, H);
  out.rig = { x: +rig.x.toFixed(4), y: +rig.y.toFixed(4) };
  out.f0_withRig = await shot(0, rig);
  out.mid_withRig = await shot(Math.floor(S.frameCount / 2), rig);
  out.mid_noRig = await shot(Math.floor(S.frameCount / 2), null);
  return JSON.stringify(out, null, 1);
})()
