(async () => {
  const A = window.__app, S = A.S;
  document.querySelector('.sw[data-bg=alpha]').click();
  document.getElementById('exp-res').value = '1024';
  A.setZoom(0.6);
  S.centerLock = true;
  const W = 1024, H = 1024;
  const t = window.__t || {};
  const dir = t.dir || 'D:/Downloads/3D 动作人物模型/Maria/output';
  const base = t.base || (S.model ? S.model.name.replace(/[^\w-]+/g, '_') : 'model');
  const rig = A.calibrateExportRig(W, H);
  // sanity: did the uploaded textures actually land on the materials?
  let meshes = 0, mapped = 0;
  S.model.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some(m => m && m.map)) mapped++;
  });
  const sizes = [];
  for (let f = 0; f < S.frameCount; f++) {
    const { dataURL } = A.renderFrameAt(f, W, H, true, rig);
    const blob = await (await fetch(dataURL)).blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    const name = base + '_f' + String(f).padStart(4, '0') + '.png';
    const r = await fetch('http://127.0.0.1:8800/save?p=' + encodeURIComponent(dir + '/' + name), { method: 'POST', body: buf });
    sizes.push(+(await r.text()));
    if (f % 4 === 3) await new Promise(res => setTimeout(res));
  }
  return JSON.stringify({ clip: S.clips.length ? S.clips[0].name : '?', frames: S.frameCount, dir,
    textures: mapped + '/' + meshes, first: sizes.slice(0, 2), last: sizes.slice(-2),
    totalMB: +(sizes.reduce((a, b) => a + b, 0) / 1048576).toFixed(2) });
})()
