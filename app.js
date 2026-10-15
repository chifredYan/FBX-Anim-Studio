import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { encodeGif } from './gifenc.js';

/** Framing default applied on import and by `⟲ 复位视角`. 0.6 leaves comfortable
 *  headroom around the character, which suits sprite-sheet export. */
const DEFAULT_ZOOM = 0.6;

/** Tool version (semantic versioning). Bump together with README / CHANGELOG. */
const VERSION = '1.0.0';

// ============================== state ==============================
const S = {
  model: null,          // root Object3D returned by FBXLoader
  mixer: null,
  clips: [],
  action: null,
  skeleton: null,       // Skeleton3D equivalent: THREE.Skeleton
  bones: [],            // flat list of {bone, depth, name}
  duration: 0,
  fps: 30,
  frameCount: 0,
  frame: 0,
  playing: false,
  facing: 'left',       // left | right | front | back (exact 90° steps, camera stays put)
  baseYawDeg: 180,      // model's own forward at rotation.y = 0 (auto-detected at load)
  inPlace: false,       // strip horizontal root motion (默认关：保留原始走位数据)
  centerLock: true,     // keep the character parked on the screen centre
  centerBase: null,     // {x,z} hip position of frame 0 == screen centre
  zoom: DEFAULT_ZOOM,   // viewport zoom factor (1 = standard framing distance)
  showFrame: true,      // draw the export frame box in the viewport
  frameBox: null,       // THREE.LineLoop previewing the exported crop
  selected: null,       // bone name
  pickMeshes: [],       // joint spheres
  origBonePos: new Map(),  // bone -> Vector3 (authored local pos, for in-place pinning)
  rootBoneName: null,
  texPool: [],          // uploaded textures awaiting assignment
  ground: null,
  skelHelper: null,
  basePos: null,        // model root position captured at frame 0
  rootBase: null,       // root-bone local position captured at frame 0
  showSkel: false,      // 骨骼线与关节球默认关闭（导出画面更干净）
  exporting: false,     // hides joints + helper while rendering out
  viewMode: 'preset',   // preset (level FBX-Review-style view) | free (orbit)
  showGround: true,
  bgMode: 'custom',     // green | white | alpha | custom
};

const $ = id => document.getElementById(id);
const vp = $('viewport');
const wrap = $('viewport-wrap');

/** All models are rescaled to this height so the grid, camera and joint
 *  spheres behave the same way for cm-unit (Mixamo) and m-unit assets. */
const TARGET_H = 1.75;

// ============================== three basics ==============================
const renderer = new THREE.WebGLRenderer({ canvas: vp, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 500);
const controls = new OrbitControls(camera, vp);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xdfe6f0, 0x40404a, 1.15));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-3, 5, 4);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
rim.position.set(3, 2, -4);
scene.add(rim);

// ground grid shared by every view
{
  const g = new THREE.GridHelper(10, 20, 0xb9b6a8, 0xd8d5c8);
  scene.add(g);
  S.ground = g;
}

function resize() {
  const r = wrap.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(wrap);
resize();

// Camera presets. The camera always sits on +Z and is *perfectly level*
// (same Y as its target) so the ground reads as a flat horizon line — no tilt,
// no bird's-eye. Side-view frame animations need that orthographic feel.
const CAM_HEIGHT_RATIO = 0.5;   // aim at half the character height
const CAM_DIST_RATIO = 2.0;     // distance = 2x character height

function resetCamera(height = TARGET_H) {
  const y = height * CAM_HEIGHT_RATIO;
  const d = height * CAM_DIST_RATIO;
  camera.position.set(0, y, d);
  controls.target.set(0, y, 0);
  controls.update();
}
resetCamera();

// ============================== logging ==============================
function log(msg, cls = '') {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.textContent = msg;
  $('log').appendChild(el);
  $('log').scrollTop = 1e6;
}

// ============================== model loading ==============================
async function loadFbxBuffer(buf, name) {
  clearModel();
  const loader = new FBXLoader();
  const obj = loader.parse(buf, '');   // textures resolved manually below
  obj.name = name.replace(/\.fbx$/i, '');

  scene.add(obj);
  obj.updateMatrixWorld(true);

  // collect skeleton + bones
  let skelRoot = null;
  obj.traverse(o => {
    if (o.isSkinnedMesh && !skelRoot) skelRoot = o;
  });
  if (!skelRoot) { log('未找到 SkinnedMesh（不是骨骼模型？）', 'err'); return; }
  S.model = obj;
  S.skeleton = skelRoot.skeleton;

  // Skinned meshes must never be frustum-culled: their geometry bounding
  // sphere comes from the bind pose, so animated poses that stretch beyond it
  // (run follow-through, slashes) would randomly vanish from the render.
  obj.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; });

  // Which way does the character actually look when rotation.y is 0?
  // Mixamo rigs differ per exporter, so measure it instead of guessing.
  S.baseYawDeg = detectForwardYawDeg();
  applyFacing(obj);
  obj.updateMatrixWorld(true);

  // unit normalisation: Mixamo exports are in centimetres
  const rawH = measureHeight(obj);
  const scale = rawH > 1e-4 ? TARGET_H / rawH : 1;
  obj.scale.multiplyScalar(scale);
  obj.updateMatrixWorld(true);
  groundAndCenter(obj);
  log(`单位归一化：${rawH.toFixed(1)} → ${TARGET_H}（缩放 ${scale.toFixed(4)}）`);

  S.bones = S.skeleton.bones.map((b, i) => ({ bone: b, name: b.name || `bone_${i}`, depth: depthOf(b, S.skeleton.bones[0]) }));
  S.rootBoneName = S.bones[0].name;

  S.origBonePos.clear();
  for (const { bone } of S.bones) S.origBonePos.set(bone, bone.position.clone());

  // mixer + clips
  S.mixer = new THREE.AnimationMixer(obj);
  S.clips = obj.animations || [];
  fillClipSelect();
  if (S.clips.length) selectClip(0); else log('FBX 中没有动画 clip', 'err');

  // capture the frame-0 root location, then re-apply with root motion removed
  captureBase();

  assignTextures();
  buildBoneTree();
  buildPickSpheres();
  frameCameraToModel();
  setZoom(DEFAULT_ZOOM);
  updatePlayRange();
  $('drop-hint').style.display = 'none';
  log(`已载入 ${name}：${S.bones.length} 根骨骼，${S.clips.length} 个 clip`, 'ok');
}

/** Sample frame 0 with root motion intact and remember where the character
 *  started, so `applyInPlace` can pin the horizontal drift back to it and
 *  `applyCentering` can keep that spot on the screen centre. */
function captureBase() {
  if (!S.skeleton || !S.model) return;
  const was = S.inPlace;
  S.inPlace = false;
  seekFrame(0, false);
  S.rootBase = S.skeleton.bones[0].position.clone();
  // frame 0 defines "centre": park its hips on the origin (screen centre)
  const v = new THREE.Vector3();
  S.skeleton.bones[0].getWorldPosition(v);
  S.model.position.x -= v.x;
  S.model.position.z -= v.z;
  S.model.updateMatrixWorld(true);
  S.basePos = S.model.position.clone();
  S.centerBase = { x: 0, z: 0 };
  S.inPlace = was;
  seekFrame(0, false);
}

/** Height of an object's world AABB. */
function measureHeight(o) {
  const box = new THREE.Box3().setFromObject(o);
  return Math.max(0, box.max.y - box.min.y);
}

/** Put the feet on y=0 and centre the model horizontally on the origin. */
function groundAndCenter(o) {
  o.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(o);
  o.position.x -= (b.min.x + b.max.x) / 2;
  o.position.z -= (b.min.z + b.max.z) / 2;
  o.position.y -= b.min.y;
  o.updateMatrixWorld(true);
}

function depthOf(bone, root) {
  let d = 0, p = bone;
  while (p && p !== root) { d++; p = p.parent; }
  return Math.max(0, d - 1);
}

function clearModel() {
  if (S.model) {
    scene.remove(S.model);
    S.model = null;
  }
  S.basePos = null; S.rootBase = null; S.centerBase = null;
  for (const m of S.pickMeshes) scene.remove(m);
  S.pickMeshes = [];
  if (S.skelHelper) { scene.remove(S.skelHelper); S.skelHelper = null; }
  S.mixer = null; S.action = null; S.clips = []; S.bones = []; S.skeleton = null;
  S.selected = null;
  $('bone-tree').innerHTML = '<div class="muted" style="padding:8px">尚未导入模型</div>';
}

function assignTextures() {
  if (!S.texPool.length || !S.model) return;
  const used = new Set();
  const loader = new THREE.TextureLoader();
  S.model.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.map) continue;                       // already has one (embedded)
      const t = S.texPool.find(t => !used.has(t));
      if (t) { m.map = t; m.needsUpdate = true; used.add(t); }
    }
  });
  if (used.size) log(`已应用 ${used.size} 张上传贴图`, 'ok');
}

// ============================== clips & timeline ==============================
function fillClipSelect() {
  const sel = $('clip');
  sel.innerHTML = '';
  S.clips.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = `${c.name || 'clip ' + i} (${c.duration.toFixed(2)}s)`;
    sel.appendChild(o);
  });
}
$('clip').addEventListener('change', e => selectClip(+e.target.value));

function selectClip(i) {
  const clip = S.clips[i];
  if (!clip) return;
  $('clip').value = i;
  if (S.action) S.action.stop();
  S.action = S.mixer.clipAction(clip);
  S.action.play();
  S.duration = clip.duration;
  updatePlayRange();
  captureBase();
  seekFrame(0, false);
}

function updatePlayRange() {
  S.frameCount = Math.max(1, Math.round(S.duration * S.fps));
  $('clip-info').textContent = `${S.duration.toFixed(2)}s · ${S.frameCount} 帧`;
  drawTrack();
}

function seekFrame(f, playState = S.playing) {
  if (!S.mixer || !S.action) return;
  S.frame = Math.max(0, Math.min(S.frameCount - 1, f));
  const t = S.frame / S.fps;
  // setTime evaluates all actions at the absolute time
  S.mixer.setTime(t);
  applyInPlace();
  applyCentering();
  scene.updateMatrixWorld(true);
  drawTrack();
  return t;
}

/** Cancel horizontal root motion so the character animates on the spot.
 *  Both drift sources are pinned back to their frame-0 value:
 *    - the skeleton root bone (mixamorig_Hips)
 *    - the model root node (some exporters animate that instead)
 *  Vertical motion (jumps, bobs) is deliberately preserved. */
function applyInPlace() {
  if (!S.inPlace || !S.skeleton) return;
  const rb = S.skeleton.bones[0];
  if (S.rootBase) {
    rb.position.x = S.rootBase.x;
    rb.position.z = S.rootBase.z;
  }
  if (S.basePos && S.model) {
    S.model.position.x = S.basePos.x;
    S.model.position.z = S.basePos.z;
  }
}

/** Keep the character planted on the screen centre: after each sample we nudge
 *  the model root so the hips sit exactly on the origin, cancelling whatever
 *  horizontal travel the clip still contains. Vertical motion (jumps, crouches)
 *  is left alone — pinning Y would make the feet float. */
function applyCentering() {
  if (!S.centerLock || !S.model || !S.skeleton || !S.centerBase) return;
  scene.updateMatrixWorld(true);   // mixer just re-posed the bones: read FRESH matrices
  const v = new THREE.Vector3();
  S.skeleton.bones[0].getWorldPosition(v);
  const dx = S.centerBase.x - v.x;
  const dz = S.centerBase.z - v.z;
  if (Math.abs(dx) < 1e-7 && Math.abs(dz) < 1e-7) return;
  S.model.position.x += dx;
  S.model.position.z += dz;
  S.model.updateMatrixWorld(true);
}

/** World-space bounding box of the skeleton (mesh bboxes ignore skinning). */
function skeletonBox() {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const b of S.skeleton.bones) {
    b.getWorldPosition(v);
    box.expandByPoint(v);
  }
  return box;
}

// ============================== bone tree & picking ==============================
function buildBoneTree() {
  const box = $('bone-tree');
  box.innerHTML = '';
  $('bone-count').textContent = `(${S.bones.length})`;
  for (const { name, depth } of S.bones) {
    const el = document.createElement('div');
    el.className = `bone-item depth-${Math.min(depth, 8)}`;
    el.dataset.name = name;
    el.innerHTML = `<span>${name}</span>`;
    el.addEventListener('click', () => selectBone(name, false));
    box.appendChild(el);
  }
}

function buildPickSpheres() {
  const geo = new THREE.SphereGeometry(1, 10, 8);
  for (const { bone, name } of S.bones) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x185fa5, transparent: true, opacity: 0.55, depthTest: false,
    }));
    m.userData.boneName = name;
    m.renderOrder = 10;
    scene.add(m);
    S.pickMeshes.push(m);
  }
  S.skelHelper = new THREE.SkeletonHelper(S.model);
  S.skelHelper.material.linewidth = 2;
  scene.add(S.skelHelper);
}

function syncPickSpheres() {
  if (!S.model) return;
  const show = S.showSkel && !S.exporting;
  const scale = camera.position.distanceTo(controls.target) * 0.012;
  const byName = new Map(S.bones.map(x => [x.name, x.bone]));
  for (const m of S.pickMeshes) {
    const b = byName.get(m.userData.boneName);
    if (!b) continue;
    b.getWorldPosition(m.position);
    const sel = m.userData.boneName === S.selected;
    m.scale.setScalar(scale * (sel ? 1.6 : 1));
    m.material.color.set(sel ? 0xe07b00 : 0x185fa5);
    m.visible = show;
  }
  if (S.skelHelper) S.skelHelper.visible = show;
}

function selectBone(name, fromViewport = true) {
  S.selected = name;
  document.querySelectorAll('.bone-item').forEach(el => {
    el.classList.toggle('sel', el.dataset.name === name);
  });
  const el = document.querySelector(`.bone-item[data-name="${CSS.escape(name)}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// viewport click picking
const ray = new THREE.Raycaster();
vp.addEventListener('pointerdown', ev => {
  if (ev.button !== 0 || !S.model) return;
  const r = vp.getBoundingClientRect();
  const ptr = new THREE.Vector2(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  ray.params.Line = { threshold: 0.05 };
  const hits = ray.intersectObjects(S.pickMeshes.filter(m => m.visible), false);
  if (hits.length) selectBone(hits[0].object.userData.boneName);
});

/* ============================== zoom ==============================
 * Zoom is expressed as a multiplier on the standard framing distance:
 *   1.00× = default (camera 2× the character height away)
 *   >1    = closer / character bigger in frame
 * The wheel, the slider and the readout all drive the same number, and every
 * export uses it too — so what you see is exactly what you get. */
function stdDistance() {
  const h = S.model ? modelHeight() : TARGET_H;
  return Math.max(0.2, h * CAM_DIST_RATIO);
}
function currentDistance() {
  return Math.max(1e-3, camera.position.distanceTo(controls.target));
}
function zoomFromCamera() {
  const z = stdDistance() / currentDistance();
  return Math.min(4, Math.max(0.25, z));
}
function setZoom(z, fromCamera = false) {
  S.zoom = Math.min(4, Math.max(0.25, z));
  if (!fromCamera) {
    const d = stdDistance() / S.zoom;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
    dir.normalize();
    camera.position.copy(controls.target).addScaledVector(dir, d);
    controls.update();
  }
  if ($('zoom').value !== String(S.zoom.toFixed(2))) $('zoom').value = S.zoom.toFixed(2);
  $('zoom-v').textContent = `${S.zoom.toFixed(2)}×`;
  updateHud();
}
/** Wheel dolly changes the distance behind our back — mirror it into the UI.
 *  Before a model exists there is no meaningful reference distance, so leave
 *  the readout at whatever the default is. */
function syncZoomFromCamera() {
  if (!S.model) return;
  const z = zoomFromCamera();
  if (Math.abs(z - S.zoom) < 0.002) return;
  S.zoom = z;
  $('zoom').value = z.toFixed(2);
  $('zoom-v').textContent = `${z.toFixed(2)}×`;
  updateHud();
}

const zoomEl = $('zoom');
zoomEl.addEventListener('input', () => setZoom(parseFloat(zoomEl.value)));
// Arrow keys fine-tune while the slider has focus: 0.01 per press, 0.1 with Shift.
zoomEl.addEventListener('keydown', ev => {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  ev.preventDefault();
  ev.stopPropagation();
  const step = ev.shiftKey ? 0.1 : 0.01;
  const next = S.zoom + (ev.key === 'ArrowRight' ? step : -step);
  setZoom(Math.round(next * 100) / 100);
});
zoomEl.addEventListener('dblclick', () => { setZoom(DEFAULT_ZOOM); log(`缩放已复位到默认 ${DEFAULT_ZOOM.toFixed(2)}×`); });

// ============================== export frame box ==============================
/** Build (once) the rectangle that previews the exported crop. Its size is the
 *  world-space extent the export camera covers at the current zoom, so it
 *  updates live as you zoom. */
function ensureFrameBox() {
  if (S.frameBox) return S.frameBox;      // build ONCE — the render loop calls this every frame
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 3), 3));
  const m = new THREE.LineBasicMaterial({ color: 0xe07b00, transparent: true, opacity: 0.95, depthTest: false });
  const line = new THREE.Line(g, m);
  line.renderOrder = 999;
  line.frustumCulled = false;
  line.visible = false;
  scene.add(line);
  S.frameBox = line;
  return line;
}

function updateFrameBox() {
  const line = ensureFrameBox();
  if (!S.showFrame || !S.model) { line.visible = false; return; }
  const d = exportDistance();
  const hh = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const hw = hh * exportAspect();
  // The box marks WHERE the exported frame lands, so its centre is the export
  // camera's own aim point — always the world origin at eye height, never the
  // character. Following per-frame bounds would make it wobble with every pose.
  const c = exportCentre();
  // With '人物居中' on, the character is pinned to that same origin each frame,
  // so the box wraps him exactly; with it off he walks out of the box, which is
  // precisely what the exported sequence will show.
  const q = camera.quaternion;                 // billboard (identity in presets)
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const corners = [
    [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh],
  ].map(([x, y]) => new THREE.Vector3()
    .copy(c).addScaledVector(right, x).addScaledVector(up, y));
  const pos = line.geometry.attributes.position;
  corners.forEach((p, i) => { pos.setXYZ(i, p.x, p.y, p.z); });
  pos.needsUpdate = true;
  line.geometry.computeBoundingSphere();
  line.visible = true;
}

// ============================== timeline drawing ==============================
function drawTrack() {
  const c = $('track-canvas');
  const r = $('track').getBoundingClientRect();
  if (!r.width) return;
  c.width = r.width * devicePixelRatio; c.height = r.height * devicePixelRatio;
  const g = c.getContext('2d');
  g.scale(devicePixelRatio, devicePixelRatio);
  const W = r.width, H = r.height;
  g.clearRect(0, 0, W, H);
  const n = S.frameCount || 1;
  // frame ticks
  g.strokeStyle = '#d3d1c7';
  g.beginPath();
  for (let f = 0; f <= n; f++) {
    const x = (f / n) * W;
    g.moveTo(x, H - 10); g.lineTo(x, H);
    if (n <= 64 || f % 5 === 0) { g.moveTo(x, H - 16); g.lineTo(x, H); }
  }
  g.stroke();
  // playhead
  const px = (S.frame / n) * W;
  g.fillStyle = '#185fa5';
  g.fillRect(px - 1, 0, 2, H);
  g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.fill();
  $('frame-label').textContent = `帧 ${S.frame} / ${S.frameCount - 1}`;
}

let dragging = false;
const trackFromEvent = ev => {
  const r = $('track').getBoundingClientRect();
  const f = Math.round(((ev.clientX - r.left) / r.width) * (S.frameCount - 1));
  seekFrame(f, S.playing);
};
$('track').addEventListener('pointerdown', ev => { dragging = true; trackFromEvent(ev); });
addEventListener('pointermove', ev => { if (dragging) trackFromEvent(ev); });
addEventListener('pointerup', () => dragging = false);

// ============================== playback loop ==============================
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = clock.getDelta();
  if (S.playing && S.mixer) {
    S.mixer.update(dt);
    applyInPlace();
    const t = S.action.time % S.duration;
    S.frame = Math.min(S.frameCount - 1, Math.round(t * S.fps));
    applyCentering();
    scene.updateMatrixWorld(true);
    drawTrack();
  }
  controls.update();
  syncZoomFromCamera();      // wheel dolly → keep the readout in sync
  syncPickSpheres();
  updateFrameBox();
  renderer.render(scene, camera);
}
loop();

$('btn-play').addEventListener('click', togglePlay);
function togglePlay() {
  S.playing = !S.playing;
  $('btn-play').textContent = S.playing ? '⏸' : '▶';
  if (S.playing && S.mixer && S.action) {
    // resume from current frame
    S.mixer.setTime(S.frame / S.fps);
  }
}
$('btn-prev').addEventListener('click', () => { S.playing = false; $('btn-play').textContent = '▶'; seekFrame(S.frame - 1); });
$('btn-next').addEventListener('click', () => { S.playing = false; $('btn-play').textContent = '▶'; seekFrame(S.frame + 1); });
$('fps').addEventListener('change', e => { S.fps = +e.target.value; updatePlayRange(); });
$('facing').addEventListener('change', e => {
  S.facing = e.target.value;
  if (S.facing === 'free') {
    setViewMode('free');                 // keep current model yaw, unlock orbit
  } else {
    setViewMode('preset');
    applyFacing();
    applyStandardView();                 // re-frame so the turn reads as a true 90°
    seekFrame(S.frame);
  }
});
$('btn-resetview').addEventListener('click', () => {
  applyStandardView();
  setZoom(DEFAULT_ZOOM);
  log(`视角已复位：绝对水平，眼高 ${(modelHeight() * CAM_HEIGHT_RATIO).toFixed(2)}m，缩放 ${DEFAULT_ZOOM.toFixed(2)}×`);
});
$('btn-frame').addEventListener('click', e => {
  S.showFrame = !S.showFrame;
  e.target.textContent = `取景框:${S.showFrame ? '开' : '关'}`;
  e.target.classList.toggle('primary', S.showFrame);
  if (S.showFrame) {
    updateFrameBox();
    log(`取景框已开：框内 = 导出画面（缩放 ${S.zoom.toFixed(2)}×）`);
  } else log('取景框已关');
});
$('btn-ground').addEventListener('click', e => {
  S.showGround = !S.showGround;
  S.ground.visible = S.showGround;
  e.target.textContent = `地面:${S.showGround ? '开' : '关'}`;
});
$('chk-inplace').addEventListener('change', e => {
  S.inPlace = e.target.checked;
  log(S.inPlace ? '消除位移：开 —— 动画里的前进位移已剥离（骨骼数据同步）' : '消除位移：关 —— 保留原始走位');
  seekFrame(S.frame);
});
$('chk-center').addEventListener('change', e => {
  S.centerLock = e.target.checked;
  if (S.centerLock) { captureBase(); log('人物居中：开 —— 人物固定在画面中心'); }
  else log('人物居中：关 —— 按原始走位播放');
  seekFrame(S.frame);
});
setViewMode('preset');   // default facing 'left' → fixed FBX-Review-style view
$('btn-skel').addEventListener('click', e => {
  S.showSkel = !S.showSkel;
  e.target.textContent = `骨骼:${S.showSkel ? '开' : '关'}`;
});
document.addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
  if (ev.code === 'Space') { ev.preventDefault(); togglePlay(); }
  if (ev.code === 'ArrowLeft') $('btn-prev').click();
  if (ev.code === 'ArrowRight') $('btn-next').click();
});

/* ============================== facing ==============================
 * The camera never moves for these four presets — it stays on +Z, level.
 * Only the model turns, and always by an exact multiple of 90°.
 *
 * Screen axes, given camera on +Z looking at the origin with up = +Y:
 *      +X = screen right,  -X = screen left,  +Z = toward camera
 * Turning the model by yaw behaves as Ry(yaw) · forward, where
 *      Ry(yaw) · (0,0,fz) = (fz·sin yaw, 0, fz·cos yaw)
 * So we first find the model's own forward axis (bind pose, rotation.y = 0),
 * express it as a base yaw, then add the preset's step. Result: front is dead
 * centre facing the camera, left/right are exactly 90° off it.
 * ==================================================================== */
const FACING_STEP = { front: 0, right: 90, left: -90, back: 180 };

/** Average world X of every bone whose name mentions left / right. */
function detectForwardYawDeg() {
  if (!S.skeleton) return S.baseYawDeg;
  const v = new THREE.Vector3();
  let lx = 0, ln = 0, rx = 0, rn = 0;
  for (const b of S.skeleton.bones) {
    const n = (b.name || '').toLowerCase();
    b.getWorldPosition(v);
    if (n.includes('left')) { lx += v.x; ln++; }
    else if (n.includes('right')) { rx += v.x; rn++; }
  }
  if (!ln || !rn) {
    log('朝向自动检测失败（骨骼名无 left/right），沿用出厂朝向 -Z');
    return 180;
  }
  // character-right = X → forward = Y × X = -Z ; character-right = -X → +Z
  const forwardZ = (rx - lx) > 0 ? -1 : 1;
  // yaw0 satisfies Ry(yaw0)·(0,0,1) == (0,0,forwardZ)
  const yaw0 = forwardZ > 0 ? 0 : 180;
  log(`朝向检测：角色自身 forward = ${forwardZ > 0 ? '+Z' : '-Z'}（基准 yaw ${yaw0}°）`);
  return yaw0;
}

function facingYawDeg() { return S.baseYawDeg + (FACING_STEP[S.facing] ?? 0); }

function applyFacing(obj = S.model) {
  if (obj) obj.rotation.y = THREE.MathUtils.degToRad(facingYawDeg());
}

/** Preset views (left/right/front/back) mimic Autodesk FBX Review:
 *  the camera sits perfectly level with its target, so the ground reads as an
 *  absolutely horizontal horizon line. Dragging pans, wheel zooms, rotation is
 *  off. 'free' restores orbiting — then you may tilt the angle yourself. */
function setViewMode(mode) {
  S.viewMode = mode;
  const preset = mode === 'preset';
  controls.enableRotate = !preset;   // preset views keep pitch/roll at 0 forever
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.mouseButtons.LEFT = preset ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  S.ground.visible = S.showGround;
  updateHud();
}

function updateHud() {
  const zoom = `缩放 ${S.zoom.toFixed(2)}×（工具栏可调，导出沿用）`;
  $('vp-hud').textContent = (S.viewMode === 'preset'
    ? '绝对水平视角 · 拖动平移 · 滚轮缩放 · 选「自由」可旋转角度'
    : '自由视角 · 拖动旋转 · 滚轮缩放 · 右键平移') + ` · ${zoom}`;
}

/** Snap the camera back to the standard level view: dead-level, centred. */
function applyStandardView() {
  frameCameraToModel();
  setZoom(S.zoom);          // keep whatever zoom the user picked
}

function frameCameraToModel() {
  if (!S.model) return;
  // measure height from skeleton bounds
  const box = new THREE.Box3().setFromObject(S.model);
  const h = Math.max(0.5, box.max.y - box.min.y);
  resetCamera(h);
}

// ============================== file input ==============================
$('btn-open').addEventListener('click', () => $('file-fbx').click());
$('file-fbx').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (f) await importFile(f);
  e.target.value = '';
});
$('btn-tex').addEventListener('click', () => $('file-tex').click());
$('file-tex').addEventListener('change', e => {
  for (const f of e.target.files) loadTextureFile(f);
  e.target.value = '';
});

async function importFile(f) {
  log(`读取 ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
  const buf = await f.arrayBuffer();
  try {
    await loadFbxBuffer(buf, f.name);
  } catch (err) {
    log(`解析失败：${err.message}`, 'err');
    console.error(err);
  }
}

function loadTextureFile(f) {
  const url = URL.createObjectURL(f);
  new THREE.TextureLoader().load(url, tex => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;                      // FBX UV convention
    tex.name = f.name;
    S.texPool.push(tex);
    if (S.model) assignTextures();
    log(`贴图就绪：${f.name}`);
  });
}

// drag & drop
wrap.addEventListener('dragover', ev => { ev.preventDefault(); wrap.classList.add('dragover'); });
wrap.addEventListener('dragleave', () => wrap.classList.remove('dragover'));
wrap.addEventListener('drop', async ev => {
  ev.preventDefault();
  wrap.classList.remove('dragover');
  const files = [...ev.dataTransfer.files];
  const fbx = files.find(f => f.name.toLowerCase().endsWith('.fbx'));
  const imgs = files.filter(f => /image\//.test(f.type));
  for (const im of imgs) loadTextureFile(im);
  if (fbx) await importFile(fbx);
});

// ============================== export ==============================
function modelHeight() {
  const box = new THREE.Box3().setFromObject(S.model);
  return Math.max(0.5, box.max.y - box.min.y);
}

function parseHex(h) {
  h = String(h || '#17171c').replace('#', '');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

// ---------- export background ----------
const BG_PRESETS = { green: '#2f9e44', white: '#ffffff' };

/** 'green' | 'white' | 'alpha' | 'custom' */
function bgMode() { return S.bgMode; }
function bgHex() {
  if (S.bgMode === 'alpha') return '#000000';   // unused: alpha channel carries it
  if (S.bgMode === 'custom') return $('exp-bg').value;
  return BG_PRESETS[S.bgMode] || '#17171c';
}
function bgTransparent() { return S.bgMode === 'alpha'; }

function setBgMode(mode) {
  S.bgMode = mode;
  document.querySelectorAll('.sw[data-bg]').forEach(el =>
    el.classList.toggle('sel', el.dataset.bg === mode));
  $('bg-hint').textContent = mode === 'alpha'
    ? '纯透明：PNG 带 alpha 通道；GIF 用透明索引（不支持半透明边缘，会硬边抠图）'
    : (mode === 'custom' ? `自定义 ${$('exp-bg').value}` : `纯色背景 ${bgHex()}`);
}

document.querySelectorAll('.sw[data-bg]').forEach(el =>
  el.addEventListener('click', () => setBgMode(el.dataset.bg)));
$('exp-bg').addEventListener('input', () => {
  $('exp-bg-hex').textContent = $('exp-bg').value;
  setBgMode('custom');
});
setBgMode('custom');

function exportOnly(on) {
  S.exporting = on;
  // visibility must change synchronously: a single-frame export renders before
  // the animation loop gets a chance to run syncPickSpheres
  const show = S.showSkel && !S.exporting;
  for (const m of S.pickMeshes) m.visible = show;
  if (S.skelHelper) S.skelHelper.visible = show;
  if (S.frameBox) S.frameBox.visible = false;   // preview box is viewport-only
}

/** Every export aims here: world origin at eye height. Fixed, so consecutive
 *  frames share one camera rig — that is exactly what the frame box draws. */
function exportCentre() {
  return new THREE.Vector3(0, TARGET_H * CAM_HEIGHT_RATIO, 0);
}
/** Point the camera at that spot from straight down +Z, dead level. */
function aimExportCameraAt(x, y, d) {
  camera.position.set(x, y, d);
  camera.up.set(0, 1, 0);
  camera.lookAt(x, y, 0);
}
function aimExportCamera(d) {
  aimExportCameraAt(0, TARGET_H * CAM_HEIGHT_RATIO, d);
}

/** Work out the one camera position the whole sequence will share.
 *  Frame 0 is framed perfectly (coarse aim + iterative pixel feedback) and the
 *  resulting height/offset is reused for every other frame. A rig that never
 *  moves means no inter-frame wobble — the character's own bob, jump and lean
 *  stay visible instead of being cancelled out. */
function calibrateExportRig(w, h) {
  if (!S.model) return null;
  const r = renderFrameAt(0, w, h, bgTransparent());
  return { x: r.camPos.x, y: r.camPos.y };
}

/** Exports are always square (w × w). */
function exportAspect() { return 1; }
/** Camera distance used by every export: the viewport zoom, literally. */
function exportDistance() {
  return stdDistance() / (S.zoom || 1);
}

/** Render one frame of the current clip at export resolution.
 *  Centring is done in two passes: a coarse skeleton-bbox aim, then a
 *  pixel-feedback pass — render on a transparent clear, measure the silhouette
 *  centroid and translate the camera so it sits dead-centre, then render the
 *  final image. Whatever the viewport camera looks like, and whatever pose the
 *  clip is in, the character always lands in the middle of the export.
 *  Returns {dataURL, w, h}. */
function renderFrameAt(frame, w, h, transparent, rig) {
  const oldSize = new THREE.Vector2();
  renderer.getSize(oldSize);
  const oldAlpha = renderer.getClearAlpha();
  const oldColor = renderer.getClearColor(new THREE.Color());
  const oldPx = renderer.getPixelRatio();
  const oldCamPos = camera.position.clone();
  const oldTarget = controls.target.clone();

  // From a hex string, not float triples: three.js colour management is on by
  // default, so float literals are read as *linear* and would come out washed out.
  renderer.setClearColor(new THREE.Color(bgHex()), transparent ? 0 : 1);

  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const groundWas = S.ground.visible;
  if (transparent) S.ground.visible = false;
  exportOnly(true);            // joints + helper must not appear in the output

  seekFrame(frame, false);

  const d = exportDistance();          // same zoom as the viewport — WYSIWYG
  const eyeY = TARGET_H * CAM_HEIGHT_RATIO;
  if (!S.centerLock) {
    // 人物居中 off → keep the rig bolted down and let the clip's own root
    // motion carry the character through (and out of) the frame.
    aimExportCamera(d);
  } else if (rig) {
    // Shared rig for the whole sequence: identical camera every frame.
    aimExportCameraAt(rig.x, rig.y, d);
  } else if (S.skeleton) {
    // Single-frame export: frame this exact pose perfectly.
    const box = skeletonBox();
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    camera.position.set(cx, eyeY, cz + d);
    camera.up.set(0, 1, 0);
    camera.lookAt(cx, eyeY, cz);

    // --- pixel-feedback: measure the silhouette, then re-centre exactly.
    // One pass is not enough: the pan<sup>→</sup>screen mapping is only linear
    // for geometry sitting exactly on the aim plane, and a posed body is not
    // flat. Iterating 3× drives the centroid error under a pixel.
    const groundDuringProbe = S.ground.visible;
    S.ground.visible = false;                 // grid must not pollute the silhouette
    const gl = renderer.getContext();
    const buf = new Uint8Array(w * h * 4);
    renderer.setClearColor(new THREE.Color(bgHex()), 0);
    for (let iter = 0; iter < 3; iter++) {
      renderer.render(scene, camera);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i + 3] > 128) { const p = i / 4; sx += p % w; sy += (p / w) | 0; n++; }
      }
      if (n <= 64) break;                     // nothing visible → nothing to fix
      const errX = sx / n - w / 2;            // right of centre positive
      const errY = h / 2 - sy / n;            // GL y is bottom-up
      if (Math.abs(errX) < 0.5 && Math.abs(errY) < 0.5) break;   // converged
      const worldH = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const worldW = worldH * camera.aspect;
      camera.position.x += errX / w * worldW;
      camera.position.y += errY / h * worldH;
      camera.lookAt(camera.position.x, camera.position.y, camera.position.z - d);
    }
    S.ground.visible = groundDuringProbe;
  }

  // --- final render with the requested background ---
  renderer.setClearColor(new THREE.Color(bgHex()), transparent ? 0 : 1);
  renderer.render(scene, camera);
  const url = vp.toDataURL('image/png');
  // Grab the framing BEFORE the viewport camera is restored — this is the pose
  // the whole sequence has to share.
  const exportCamPos = camera.position.clone();

  // restore
  camera.position.copy(oldCamPos);
  controls.target.copy(oldTarget);
  camera.updateMatrixWorld(true);
  exportOnly(false);
  S.ground.visible = groundWas;
  renderer.setClearColor(oldColor, oldAlpha);
  renderer.setPixelRatio(oldPx);
  renderer.setSize(oldSize.x, oldSize.y, false);
  camera.aspect = oldSize.x / oldSize.y;
  camera.updateProjectionMatrix();
  return { dataURL: url, w, h, camPos: exportCamPos };
}

function dataURLtoBlob(dataurl) {
  const [head, b64] = dataurl.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.rel = 'noopener';
  // Chromium cancels downloads triggered by a detached anchor; it must be in the DOM.
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
}

function modelBase() { return (S.model?.name || 'model').replace(/[^\w-]+/g, '_'); }

function openDlg(title, body) {
  $('dlg-title').textContent = title;
  $('dlg-body').textContent = body || '';
  $('dlg-bar').value = 0;
  $('dlg-export').showModal();
}
function dlgProgress(p) { $('dlg-bar').value = p * 100; }
$('dlg-close').addEventListener('click', () => $('dlg-export').close());

// ---- single PNG ----
$('exp-png1').addEventListener('click', () => {
  if (!S.model) return;
  const w = +$('exp-res').value, h = w;
  const { dataURL } = renderFrameAt(S.frame, w, h, bgTransparent());
  download(dataURLtoBlob(dataURL), `${modelBase()}_f${String(S.frame).padStart(4, '0')}.png`);
  log(`单帧 PNG 已导出（${w}x${h} · 缩放 ${S.zoom.toFixed(2)}× · ${bgTransparent() ? '透明' : bgHex()}）`, 'ok');
});

// ---- PNG sequence zip ----
$('exp-pngseq').addEventListener('click', async () => {
  if (!S.model) return;
  const w = +$('exp-res').value, h = w;
  const n = S.frameCount;
  openDlg('导出 PNG 序列', `${n} 帧 · ${w}x${h} · 缩放 ${S.zoom.toFixed(2)}×`);
  const rig = S.centerLock ? calibrateExportRig(w, h) : null;   // one rig for all frames
  const files = {};
  for (let f = 0; f < n; f++) {
    const { dataURL } = renderFrameAt(f, w, h, bgTransparent(), rig);
    const blob = dataURLtoBlob(dataURL);
    files[`${modelBase()}_f${String(f).padStart(4, '0')}.png`] = new Uint8Array(await blob.arrayBuffer());
    dlgProgress((f + 1) / n);
    if (f % 4 === 3) await new Promise(r => setTimeout(r));   // keep UI alive
  }
  files['meta.json'] = strToU8(JSON.stringify(metaPayload(), null, 1));
  const zipped = zipSync(files, { level: 6 });
  download(new Blob([zipped], { type: 'application/zip' }), `${modelBase()}_png_seq.zip`);
  $('dlg-body').textContent = `完成：${n} 帧 + meta.json`;
  log(`PNG 序列已导出（${n} 帧 ZIP）`, 'ok');
});

// ---- GIF ----
$('exp-gif').addEventListener('click', async () => {
  if (!S.model) return;
  const w = Math.min(1024, +$('exp-res').value), h = w;
  const n = S.frameCount;
  const trans = bgTransparent();
  const hex = bgHex();
  const bg = parseHex(hex);
  openDlg('导出 GIF', `${n} 帧 · ${w}x${h} · ${S.fps}fps · 缩放 ${S.zoom.toFixed(2)}× · ${trans ? '透明' : hex}`);
  const rig = S.centerLock ? calibrateExportRig(w, h) : null;   // one rig for all frames
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const frames = [];
  for (let f = 0; f < n; f++) {
    const { dataURL } = renderFrameAt(f, w, h, trans, rig);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataURL; });
    ctx.clearRect(0, 0, w, h);
    if (!trans) { ctx.fillStyle = hex; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    frames.push({ rgba: d, w, h, delayMs: 1000 / S.fps });
    dlgProgress((f + 1) / n * 0.8);
    if (f % 3 === 2) await new Promise(r => setTimeout(r));
  }
  await new Promise(r => setTimeout(r));
  const gif = encodeGif(frames, { transparent: trans, bg, loop: 0 });
  dlgProgress(1);
  download(new Blob([gif], { type: 'image/gif' }), `${modelBase()}${trans ? '_alpha' : ''}.gif`);
  $('dlg-body').textContent = `完成：${n} 帧，${(gif.length / 1e6).toFixed(2)} MB`;
  log(`GIF 已导出（${n} 帧，${trans ? '透明' : hex}，${(gif.length / 1e6).toFixed(2)} MB）`, 'ok');
});

// ---- bone JSON ----
function metaPayload() {
  return {
    tool: 'FBX-Anim-Studio',
    tool_version: VERSION,
    source: modelBase(),
    animation: S.clips[$('clip').value]?.name || '',
    fps: S.fps,
    frame_count: S.frameCount,
    duration_sec: S.duration,
    bone_count: S.bones.length,
    facing: S.facing,                 // left | right | front | back
    facing_yaw_deg: facingYawDeg(),   // exact rotation applied to the model root
    model_forward_axis: S.baseYawDeg === 180 ? '-Z' : '+Z',
    in_place: S.inPlace,
    center_lock: S.centerLock,        // character pinned to the screen centre
    zoom: round6(S.zoom),             // framing multiplier shared by viewport + export
    export_distance: round6(exportDistance()),
    background: bgTransparent() ? 'transparent' : bgHex(),
    convention: {
      handedness: 'right-handed (three.js)',
      up: '+Y', forward_at_yaw0: '-Z',
      rotation: 'quaternion xyzw',
      pose_space: 'bone-local, parent-relative',
    },
  };
}

$('exp-json').addEventListener('click', async () => {
  if (!S.model) return;
  openDlg('导出骨骼 JSON', `采样 ${S.frameCount} 帧 × ${S.bones.length} 骨骼`);
  const wasPlaying = S.playing; S.playing = false;
  const frames = [];
  for (let f = 0; f < S.frameCount; f++) {
    seekFrame(f, false);
    const local = [], global = [];
    const _v3 = v => [round6(v.x), round6(v.y), round6(v.z)];
    const _q4 = q => [round6(q.x), round6(q.y), round6(q.z), round6(q.w)];
    for (const b of S.skeleton.bones) {
      local.push({ name: b.name, t: _v3(b.position), r: _q4(b.quaternion), s: _v3(b.scale) });
      const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
      b.matrixWorld.decompose(wp, wq, ws);
      global.push({ name: b.name, t: _v3(wp), r: _q4(wq) });
    }
    frames.push({ frame: f, time: round6(f / S.fps), local, global });
    dlgProgress((f + 1) / S.frameCount);
    if (f % 8 === 7) await new Promise(r => setTimeout(r));
  }
  S.playing = wasPlaying;
  const payload = { ...metaPayload(), bone_names: S.bones.map(x => x.name), frames };
  download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `${modelBase()}_bones.json`);
  $('dlg-body').textContent = `完成：${frames.length} 帧 × ${S.bones.length} 骨骼`;
  log('骨骼 JSON 已导出', 'ok');
});

const round6 = v => Math.round(v * 1e6) / 1e6;

// debug / power-user hook
window.__app = { S, THREE, scene, camera, controls, renderer, seekFrame, renderFrameAt, selectBone,
  encodeGif, download, bgHex, bgTransparent, setBgMode, facingYawDeg, detectForwardYawDeg,
  applyFacing, resetCamera, frameCameraToModel, setViewMode,
  setZoom, zoomFromCamera, exportDistance, exportCentre, stdDistance, updateFrameBox,
  calibrateExportRig, aimExportCamera, VERSION };

// ---- startup banner ----
document.title = `FBX Anim Studio v${VERSION}`;
$('ver').textContent = 'v' + VERSION;
log(`FBX Anim Studio v${VERSION} 就绪 — 导入 FBX，或直接把 .fbx 拖进视口`, 'ok');
