#!/usr/bin/env python3
"""
Bake GIST's realistic characters from MakeHuman 1.2.0 (CC0 assets) into glTF binaries.

Usage:  MH_ROOT=/path/to/makehuman python3 tools/mh_export.py [f|m|all]

Output (public/characters/):
  human_f.glb / human_m.glb   skinned body (hi + low-poly), eyes, brows, lashes,
                              hair variants, shoe variants, morph targets
                              (body types + face shapes), animation clips
                              (idle / walk / run) on the 53-bone game-engine rig.
  tex/*.{jpg,webp,png}        downscaled textures (shared between the two files)
  manifest.json               what is inside, material -> texture mapping, etc.

MakeHuman's python modules are driven headless (see mhboot.py). Everything is
exported in metres, Y up, character facing +Z, feet on y=0, left side = +X.
"""
import os, sys, json, math, struct, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhboot  # noqa: F401  (sets up MakeHuman import paths / stubs)
import files3d, human, humanmodifier, skeleton, proxy, bvh, getpath  # noqa: E402
import transformations as tm  # noqa: E402
from core import G  # noqa: E402
from PIL import Image  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, '..', 'public', 'characters'))
TEX_DIR = os.path.join(OUT_DIR, 'tex')
SCALE = 0.1  # MakeHuman works in decimetres

def dp(*parts):
    return getpath.getSysDataPath(os.path.join(*parts))

# ----------------------------------------------------------------------------- config

HAIR = {
    # id -> MakeHuman hair asset
    'afro01': 'hair/afro01/afro01.mhpxy',
    'braid01': 'hair/braid01/braid01.mhpxy',
    'bob01': 'hair/bob01/bob01.mhpxy',
    'long01': 'hair/long01/long01.mhpxy',
    'ponytail01': 'hair/ponytail01/ponytail01.mhpxy',
    'short01': 'hair/short01/short01.mhpxy',
    'short02': 'hair/short02/short02.mhpxy',
    'short03': 'hair/short03/short03.mhpxy',
    'short04': 'hair/short04/short04.mhpxy',
}
SHOES = {
    'shoes05': 'clothes/shoes05/shoes05.mhpxy',  # white sneakers
    'shoes06': 'clothes/shoes06/shoes06.mhpxy',  # blue runners
    'shoes03': 'clothes/shoes03/shoes03.mhpxy',  # black formal
    'shoes01': 'clothes/shoes01/shoes01.mhpxy',  # brown loafers
    'shoes02': 'clothes/shoes02/shoes02.mhpxy',  # worn sneakers
}

SEXES = {
    'f': dict(
        gender=0.0,
        hair=['afro01', 'braid01', 'bob01', 'long01', 'ponytail01', 'short04', 'short02', 'short01'],
        brows='eyebrows/eyebrow001/eyebrow001.mhpxy',
        lashes='eyelashes/eyelashes01/eyelashes01.mhpxy',
        lo='proxymeshes/female1605/female1605.mhpxy',
        skin='young_darkskinned_female_diffuse.png',
        skin_light='young_lightskinned_female_diffuse.png',
        variants={
            'slim': {'macrodetails-universal/Weight': 0.36, 'macrodetails-universal/Muscle': 0.45},
            'athletic': {'macrodetails-universal/Muscle': 0.82, 'macrodetails-universal/Weight': 0.5},
            'curvy': {'macrodetails-universal/Weight': 0.64, 'breast/BreastSize': 0.72,
                      'hip/hip-scale-horiz-decr|incr': 0.35, 'buttocks/buttocks-volume-decr|incr': 0.45},
        },
    ),
    'm': dict(
        gender=1.0,
        hair=['afro01', 'short04', 'short02', 'short01', 'short03', 'braid01', 'long01', 'ponytail01'],
        brows='eyebrows/eyebrow008/eyebrow008.mhpxy',
        lashes='eyelashes/eyelashes03/eyelashes03.mhpxy',
        lo='proxymeshes/male1591/male1591.mhpxy',
        skin='young_darkskinned_male_diffuse.png',
        skin_light='young_lightskinned_male_diffuse.png',
        variants={
            'slim': {'macrodetails-universal/Weight': 0.36, 'macrodetails-universal/Muscle': 0.42},
            'athletic': {'macrodetails-universal/Muscle': 0.86, 'macrodetails-universal/Weight': 0.54},
            'curvy': {'macrodetails-universal/Weight': 0.72, 'macrodetails-universal/Muscle': 0.56},
        },
    ),
}
FACE_VARIANTS = {
    'face_oval': {'head/head-oval': 0.85},
    'face_round': {'head/head-round': 0.85},
    'face_square': {'head/head-square': 0.85},
}
BASE_MACROS = {
    'macrodetails/Age': 0.5, 'macrodetails/African': 1.0, 'macrodetails/Asian': 0.0,
    'macrodetails/Caucasian': 0.0, 'macrodetails-universal/Muscle': 0.5,
    'macrodetails-universal/Weight': 0.5, 'macrodetails-height/Height': 0.5,
    'macrodetails-proportions/BodyProportions': 0.5,
}

# body regions (vertex attribute _REGION) -> index.  The runtime hides regions covered by clothes.
REGIONS = ['head', 'torso_up', 'torso_lo',
           'uarm_hi_l', 'uarm_lo_l', 'farm_l', 'hand_l',
           'uarm_hi_r', 'uarm_lo_r', 'farm_r', 'hand_r',
           'thigh_hi_l', 'thigh_lo_l', 'shin_l', 'foot_l',
           'thigh_hi_r', 'thigh_lo_r', 'shin_r', 'foot_r']
BONE_REGION = {
    'Root': 'torso_lo', 'pelvis': 'torso_lo', 'spine_01': 'torso_lo',
    'spine_02': 'torso_up', 'spine_03': 'torso_up', 'clavicle_l': 'torso_up', 'clavicle_r': 'torso_up',
    'neck_01': 'head', 'head': 'head',
    'upperarm_l': 'uarm_l', 'upperarm_r': 'uarm_r', 'lowerarm_l': 'farm_l', 'lowerarm_r': 'farm_r',
    'hand_l': 'hand_l', 'hand_r': 'hand_r',
    'thigh_l': 'thigh_l', 'thigh_r': 'thigh_r', 'calf_l': 'shin_l', 'calf_r': 'shin_r',
    'foot_l': 'foot_l', 'foot_r': 'foot_r', 'ball_l': 'foot_l', 'ball_r': 'foot_r',
}

# walk1.bvh uses MakeHuman 1.0's "soft1" rig names -> game-engine bones
SOFT1_MAP = {
    'pelvis': 'Root', 'spine_01': 'Spine1', 'spine_02': 'Spine2', 'spine_03': 'Spine3',
    'neck_01': 'Neck', 'head': 'Head',
    'clavicle_l': 'Clavicle_L', 'upperarm_l': 'UpArm_L', 'lowerarm_l': 'LoArm_L', 'hand_l': 'Hand_L',
    'clavicle_r': 'Clavicle_R', 'upperarm_r': 'UpArm_R', 'lowerarm_r': 'LoArm_R', 'hand_r': 'Hand_R',
    'thigh_l': 'UpLeg_L', 'calf_l': 'LoLeg_L', 'foot_l': 'Foot_L', 'ball_l': 'Toe_L',
    'thigh_r': 'UpLeg_R', 'calf_r': 'LoLeg_R', 'foot_r': 'Foot_R', 'ball_r': 'Toe_R',
}
for _f, _b in [('index', 'Index'), ('middle', 'Middle'), ('ring', 'Ring'), ('pinky', 'Pinky'), ('thumb', 'Thumb')]:
    for _s in ('l', 'r'):
        for _i in (1, 2, 3):
            SOFT1_MAP['%s_0%d_%s' % (_f, _i, _s)] = '%s%d_%s' % (_b, _i, _s.upper())
SOFT1_DIR_CHILD = {'Hand_L': 'Middle1_L', 'Hand_R': 'Middle1_R', 'Root': None, 'Head': None}

# ----------------------------------------------------------------------------- helpers

def log(*a):
    print('[mh_export]', *a, flush=True)

def _json_default(o):
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError('not serialisable: %r' % type(o))

def normalize(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v

def rot_between(a, b):
    """Minimal rotation matrix taking unit vector a onto unit vector b."""
    a = normalize(np.asarray(a, dtype=np.float64)); b = normalize(np.asarray(b, dtype=np.float64))
    c = float(np.dot(a, b)); axis = np.cross(a, b); s = float(np.linalg.norm(axis))
    if s < 1e-8:
        if c > 0:
            return np.identity(3)
        # 180 degrees: pick any perpendicular axis
        p = np.cross(a, [1, 0, 0])
        if np.linalg.norm(p) < 1e-6:
            p = np.cross(a, [0, 1, 0])
        return tm.rotation_matrix(math.pi, normalize(p))[:3, :3]
    return tm.rotation_matrix(math.atan2(s, c), axis / s)[:3, :3]

def quat_wxyz_to_xyzw(q):
    return [float(q[1]), float(q[2]), float(q[3]), float(q[0])]

def mat_to_trs(m):
    """4x4 -> (translation[3], quaternion xyzw[4]) ; scale assumed 1."""
    t = m[:3, 3].astype(np.float64)
    r = m[:3, :3].astype(np.float64)
    # orthonormalise (guards against float drift)
    u, _, vt = np.linalg.svd(r)
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1; r = u @ vt
    m4 = np.identity(4); m4[:3, :3] = r
    q = tm.quaternion_from_matrix(m4)
    return t, np.array(quat_wxyz_to_xyzw(q))

# ----------------------------------------------------------------------------- human setup

class Character:
    def __init__(self, sex):
        self.sex = sex
        self.cfg = SEXES[sex]
        t = time.time()
        mesh = files3d.loadMesh(dp('3dobjs/base.obj'), maxFaces=5)
        self.h = human.Human(mesh)
        G.app.selectedHuman = self.h
        self.base_skel = skeleton.load(dp('rigs/default.mhskel'), self.h.meshData)
        self.h.setBaseSkeleton(self.base_skel)
        humanmodifier.loadModifiers(dp('modifiers/modeling_modifiers.json'), self.h)
        self.base_values = dict(BASE_MACROS, **{'macrodetails/Gender': self.cfg['gender']})
        self.apply(self.base_values)
        self.skel = skeleton.load(dp('rigs/game_engine.mhskel'), self.h.meshData)
        self.h.setSkeleton(self.skel)
        self.bones = self.skel.getBones()
        self.bone_index = {b.name: i for i, b in enumerate(self.bones)}
        # ground = lowest point of the (visible) body, so feet rest on y=0
        self.ground_y = float(self.h.meshData.coord[self.visible_vert_mask()][:, 1].min())
        log('human %s ready in %.1fs, height %.1f cm, ground y=%.3f' % (sex, time.time() - t, self.h.getHeightCm(), self.ground_y))

    def visible_vert_mask(self):
        m = self.h.meshData
        vis = np.zeros(len(m.coord), dtype=bool)
        vis[np.unique(m.fvert[m.face_mask])] = True
        return vis

    def apply(self, values):
        """Set modifier values (others reset to their base value) and rebuild the mesh."""
        for name in self._touched() | set(values.keys()):
            mod = self.h.getModifier(name)
            v = values.get(name, self.base_values.get(name, mod.getDefaultValue()))
            mod.setValue(v)
        self._last = set(values.keys())
        self.h.applyAllTargets()

    def _touched(self):
        return getattr(self, '_last', set())

    def to_world(self, coords):
        """MakeHuman dm, centred -> metres with feet on y=0."""
        c = np.asarray(coords, dtype=np.float64).copy()
        c[:, 1] -= self.ground_y
        return c * SCALE

    def body_weights(self):
        if getattr(self, '_ge_weights', None) is None:
            self._ge_weights = self.remap_weights(self.h.getVertexWeights())
        return self._ge_weights

    def remap_weights(self, default_vbw):
        """Default-rig (163 bones) vertex weights -> game-engine rig (53 bones).

        MakeHuman's own remap drops bones without an explicit reference (jaw, eyes,
        tongue, eyelids...) and parks those vertices on the root bone, which breaks
        faces and eyeballs once posed. We instead climb the default-rig hierarchy
        until we hit a bone referenced by the game rig."""
        import animation
        dmap = {}
        for b in self.bones:
            for r in (b.weight_reference_bones or []):
                dmap.setdefault(r, b.name)
            for r in (b.reference_bones or []):
                dmap.setdefault(r, b.name)
        cache = {}
        def resolve(dname):
            if dname in cache:
                return cache[dname]
            d = self.base_skel.getBone(dname) if self.base_skel.containsBone(dname) else None
            g = None
            while d is not None:
                if d.name in dmap:
                    g = dmap[d.name]; break
                d = d.parent
            if g is None:
                g = self.bone_index and (dname if dname in self.bone_index else 'Root')
            cache[dname] = g
            return g
        acc = {}
        for dname, (verts, ws) in default_vbw.data.items():
            g = resolve(dname)
            a = acc.setdefault(g, {})
            for v, w in zip(verts, ws):
                v = int(v); a[v] = a.get(v, 0.0) + float(w)
        data = {g: [(k, d[k]) for k in sorted(d.keys())] for g, d in acc.items()}
        return animation.VertexBoneWeights(data, vertexCount=default_vbw.vertexCount, rootBone='Root')

# ----------------------------------------------------------------------------- mesh extraction

class MeshData:
    """Unified, triangulated mesh ready for glTF (per-vertex uv, split on seams)."""
    def __init__(self, name, positions, normals, uvs, indices, joints, weights, material, src_index, extras=None):
        self.name = name; self.positions = positions; self.normals = normals; self.uvs = uvs
        self.indices = indices; self.joints = joints; self.weights = weights; self.material = material
        self.src_index = src_index  # unified vertex -> source vertex (for morph deltas)
        self.targets = {}  # name -> (nUnified,3) deltas
        self.extras = extras or {}
        self.region = None
        self.loop = None
        self.base_index = None

def weights_to_arrays(vbw, nverts, bone_index, max_bones=4):
    """VertexBoneWeights -> (joints uint16 (n,4), weights float32 (n,4))."""
    per_vert = [[] for _ in range(nverts)]
    for bname, (vidx, w) in vbw.data.items():
        bi = bone_index.get(bname)
        if bi is None:
            continue
        for v, ww in zip(vidx, w):
            if ww > 0:
                per_vert[int(v)].append((float(ww), bi))
    J = np.zeros((nverts, 4), dtype=np.uint16); W = np.zeros((nverts, 4), dtype=np.float32)
    missing = 0
    for i, lst in enumerate(per_vert):
        if not lst:
            missing += 1; W[i, 0] = 1.0; J[i, 0] = 0
            continue
        lst.sort(reverse=True); lst = lst[:max_bones]
        s = sum(x[0] for x in lst)
        for k, (ww, bi) in enumerate(lst):
            J[i, k] = bi; W[i, k] = ww / s
    return J, W, missing

def unify(name, coord, fvert, texco, fuvs, vnorm, J, W, material, extras=None):
    """Split vertices on UV seams, triangulate quads, flip V for glTF."""
    nf = len(fvert)
    fv = np.asarray(fvert).reshape(nf, -1); fu = np.asarray(fuvs).reshape(nf, -1)
    key_to_idx = {}
    src = []; uvl = []
    tri = []
    def vid(v, u):
        k = (int(v), int(u))
        i = key_to_idx.get(k)
        if i is None:
            i = len(src); key_to_idx[k] = i; src.append(int(v)); uvl.append(int(u))
        return i
    for f in range(nf):
        vs = fv[f]; us = fu[f]
        if len(vs) == 4 and vs[3] == vs[2]:
            vs = vs[:3]; us = us[:3]
        ids = [vid(v, u) for v, u in zip(vs, us)]
        if len(ids) == 3:
            tri.append(ids)
        else:
            tri.append([ids[0], ids[1], ids[2]]); tri.append([ids[0], ids[2], ids[3]])
    src = np.array(src, dtype=np.int64); uvl = np.array(uvl, dtype=np.int64)
    pos = np.asarray(coord, dtype=np.float32)[src]
    nor = np.asarray(vnorm, dtype=np.float32)[src]
    uv = np.asarray(texco, dtype=np.float32)[uvl].copy(); uv[:, 1] = 1.0 - uv[:, 1]
    idx = np.array(tri, dtype=np.uint32)
    # winding check: compare triangle normals with vertex normals, flip if mostly opposite
    p0, p1, p2 = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
    fn = np.cross(p1 - p0, p2 - p0)
    vn = nor[idx[:, 0]] + nor[idx[:, 1]] + nor[idx[:, 2]]
    agree = float(np.mean(np.einsum('ij,ij->i', fn, vn) > 0))
    if agree < 0.5:
        idx = idx[:, [0, 2, 1]]
    return MeshData(name, pos, nor, uv, idx, J[src], W[src], material, src, extras)

def body_mesh(ch, material='skin'):
    """Visible body (helpers filtered) + mapping from clone verts to base verts."""
    clone = ch.h.meshData.clone(1.0, filterMaskedVerts=True)
    clone.calcNormals()
    raw = ch.body_weights()
    vbw = clone.getVertexWeights(raw)
    J, W, missing = weights_to_arrays(vbw, len(clone.coord), ch.bone_index)
    if missing:
        log('body: %d vertices without weights' % missing)
    md = unify('body', ch.to_world(clone.coord), clone.fvert, clone.texco, clone.fuvs, clone.vnorm, J, W, material)
    # unified -> clone vertex -> base vertex (for morphs)
    md.base_index = np.asarray(clone.parent_map)[md.src_index]
    md.clone = clone
    return md

def proxy_mesh(ch, path, ptype, name, material):
    pxy = proxy.loadProxy(ch.h, dp(path), type=ptype)
    pm, _obj = pxy.loadMeshAndObject(ch.h)
    coords = pxy.getCoords()
    pm.changeCoords(coords); pm.calcNormals()
    if pxy.hasCustomVertexWeights():
        vbw = ch.remap_weights(pxy.vertexBoneWeights)
    else:
        vbw = pxy.getVertexWeights(ch.body_weights())
    J, W, missing = weights_to_arrays(vbw, len(pm.coord), ch.bone_index)
    if missing:
        log('%s: %d vertices without weights' % (name, missing))
    md = unify(name, ch.to_world(coords), pm.fvert, pm.texco, pm.fuvs, pm.vnorm, J, W, material)
    md.proxy = pxy
    md.mh_mesh = pm
    md.extras['z_depth'] = int(getattr(pxy, 'z_depth', 50))
    md.extras['delete_verts'] = None
    if pxy.deleteVerts is not None and pxy.deleteVerts.any():
        md.extras['delete_verts'] = np.nonzero(pxy.deleteVerts)[0]
    return md

def proxy_coords(ch, md):
    """Refit a proxy to the current (morphed) body."""
    return ch.to_world(md.proxy.getCoords())


# ----------------------------------------------------------------------------- clothing helpers

# MakeHuman's clothing helper shells (CC0): clean quad loops that follow the body and its
# morph targets. The game cuts garments out of them at runtime (see src/game/tailor.ts).
HELPERS = {'tights': 'helper-tights', 'skirt': 'helper-skirt', 'scalp': 'helper-hair'}
LANDMARKS = {
    'head': 'joint-head', 'head_top': 'joint-head-2', 'neck': 'joint-neck', 'chin': 'joint-jaw',
    'mouth': 'joint-mouth', 'eye_l': 'joint-l-eye', 'eye_r': 'joint-r-eye',
    'shoulder_l': 'joint-l-shoulder', 'shoulder_r': 'joint-r-shoulder',
    'wrist_l': 'joint-l-hand', 'wrist_r': 'joint-r-hand', 'pelvis': 'joint-pelvis',
    'hip_l': 'joint-l-upper-leg', 'hip_r': 'joint-r-upper-leg', 'knee_l': 'joint-l-knee',
    'ankle_l': 'joint-l-ankle', 'chest': 'joint-spine-3', 'waist': 'joint-spine-2',
}

def group_faces(ch, gname):
    m = ch.h.meshData
    names = [n if isinstance(n, str) else n.name for n in m.getFaceGroups()]
    return np.where(m.group == names.index(gname))[0]

def full_weights(ch):
    if getattr(ch, '_full_JW', None) is None:
        m = ch.h.meshData
        J, W, missing = weights_to_arrays(ch.body_weights(), len(m.coord), ch.bone_index)
        ch._full_JW = (J, W)
    return ch._full_JW

def landmarks(ch):
    """Named reference points (metres, feet on y=0) for the current morph state."""
    m = ch.h.meshData
    world = ch.to_world(m.coord)
    out = {}
    for name, g in LANDMARKS.items():
        verts = np.unique(m.fvert[group_faces(ch, g)].ravel())
        out[name] = [round(float(v), 4) for v in world[verts].mean(axis=0)]
    # ears: outermost visible head vertices at eye height
    body = np.unique(m.fvert[group_faces(ch, 'body')].ravel())
    P = world[body]
    ey = out['eye_l'][1]
    band = body[np.abs(world[body, 1] - ey) < 0.012]
    if len(band):
        l = band[np.argmax(world[band, 0])]; r = band[np.argmin(world[band, 0])]
        out['ear_l'] = [round(float(v), 4) for v in world[l]]
        out['ear_r'] = [round(float(v), 4) for v in world[r]]
    # mouth / nose / chin from the teeth helpers and the face profile (joint-mouth is the jaw pivot, not the lips)
    def cen(g):
        v = np.unique(m.fvert[group_faces(ch, g)].ravel()); return world[v].mean(axis=0)
    mouth_y = float((cen('helper-upper-teeth')[1] + cen('helper-lower-teeth')[1]) / 2)
    sel = (np.abs(P[:, 0]) < 0.01) & (np.abs(P[:, 1] - mouth_y) < 0.008)
    lip_z = float(P[sel, 2].max()) if sel.any() else 0.15
    out['mouth'] = [0.0, round(mouth_y, 4), round(lip_z, 4)]
    sel = (np.abs(P[:, 0]) < 0.01) & (P[:, 1] > mouth_y + 0.01) & (P[:, 1] < ey)
    if sel.any():
        out['nose'] = [round(float(v), 4) for v in P[sel][np.argmax(P[sel, 2])]]
    sel = (np.abs(P[:, 0]) < 0.012) & (P[:, 2] > lip_z - 0.035) & (P[:, 1] < mouth_y) & (P[:, 1] > mouth_y - 0.09)
    if sel.any():
        out['chin'] = [round(float(v), 4) for v in P[sel][np.argmin(P[sel, 1])]]
    return out

def helper_mesh(ch, key, material='cloth'):
    """Unified helper shell with regions, loop ids and cylindrical UVs."""
    m = ch.h.meshData
    m.calcNormals()
    faces = group_faces(ch, HELPERS[key])
    fvert = m.fvert[faces]
    J, W = full_weights(ch)
    n_all = len(m.coord)
    # one uv slot per vertex (no seams yet) -> unify keeps one vertex per source vertex
    md = unify(key, ch.to_world(m.coord), fvert, np.zeros((n_all, 2), np.float32), fvert, m.vnorm, J, W, material)
    md.base_index = md.src_index.copy()
    compute_regions(ch, md, None)
    compute_loops_and_uvs(ch, md, mode=('torso' if key != 'tights' else 'parts'))
    split_uv_seams(md)
    return md

def arm_param(ch, P, side):
    """Arc length (m) along shoulder->elbow->wrist->fingers for points P, plus angle-around u."""
    heads = {b.name: ch.to_world(b.getRestHeadPos()[None, :])[0] for b in ch.bones}
    tails = {b.name: ch.to_world(b.getRestTailPos()[None, :])[0] for b in ch.bones}
    chain = [heads['upperarm_' + side], heads['lowerarm_' + side], heads['hand_' + side], tails['hand_' + side]]
    P = np.asarray(P, dtype=np.float64).reshape(-1, 3)
    best_d = np.full(len(P), np.inf); best_t = np.zeros(len(P)); best_u = np.zeros(len(P))
    acc = 0.0
    for a, b in zip(chain[:-1], chain[1:]):
        ax = b - a; L = float(np.linalg.norm(ax)); ax = ax / L
        c = np.cross(ax, [0, 0, 1.0]); c /= np.linalg.norm(c); bb = np.cross(ax, c)
        d = P - a; t = np.clip(d @ ax, 0, L); perp = d - np.outer(t, ax)
        dist = np.linalg.norm(perp, axis=1)
        better = dist < best_d
        best_d[better] = dist[better]; best_t[better] = acc + t[better]
        best_u[better] = 0.5 + np.arctan2(perp[better] @ bb, perp[better] @ c) / (2 * np.pi)
        acc += L
    return best_t, best_u

def region_bounds(ch, body, variants):
    """Conservative per-region extents over all morph variants: y range and, for arms, the
    arc-length range along the arm (same parametrisation as the helper _LOOP values)."""
    out = {}
    names = [REGIONS[r] for r in body.region]
    for vname in [None] + list(variants.keys()):
        pos = body.positions.astype(np.float64)
        if vname is not None:
            pos = pos + body.targets[vname]
        p = pos[:, 1].copy()
        for side in ('l', 'r'):
            sel = np.array([n.startswith(('uarm', 'farm', 'hand')) and n.endswith('_' + side) for n in names])
            if sel.any():
                p[sel] = arm_param(ch, pos[sel], side)[0]
        for r in REGIONS:
            sel = np.array([n == r for n in names])
            if not sel.any():
                continue
            b = out.setdefault(r, {'ymin': 1e9, 'ymax': -1e9, 'pmin': 1e9, 'pmax': -1e9})
            b['ymin'] = min(b['ymin'], float(pos[sel, 1].min())); b['ymax'] = max(b['ymax'], float(pos[sel, 1].max()))
            b['pmin'] = min(b['pmin'], float(p[sel].min())); b['pmax'] = max(b['pmax'], float(p[sel].max()))
    return {r: {k: round(v, 4) for k, v in b.items()} for r, b in out.items()}

def compute_loops_and_uvs(ch, md, mode='parts'):
    pos = md.positions.astype(np.float64); n = len(pos)
    reg = [REGIONS[r] for r in md.region]
    heads = {b.name: ch.to_world(b.getRestHeadPos()[None, :])[0] for b in ch.bones}
    tails = {b.name: ch.to_world(b.getRestTailPos()[None, :])[0] for b in ch.bones}
    part = np.zeros(n, dtype=np.int8)       # 0 torso/neck, 1 arm_l, 2 arm_r, 3 leg_l, 4 leg_r
    param = pos[:, 1].copy()                 # along-part coordinate (m): y, or arc length for arms
    u = np.zeros(n)
    tor = np.array([r in ('head', 'torso_up', 'torso_lo') for r in reg])
    zc = float(pos[tor, 2].mean()) if tor.any() else float(pos[:, 2].mean())
    if mode == 'parts':
        lower = np.array([r.startswith(('thigh', 'shin', 'foot', 'torso_lo')) for r in reg])
        mid = lower & (np.abs(pos[:, 0]) < 0.025)
        crotch_y = float(pos[mid, 1].min()) if mid.any() else 0.75
        for i, r in enumerate(reg):
            if r.startswith(('uarm', 'farm', 'hand')):
                part[i] = 1 if r.endswith('_l') else 2
            elif lower[i] and pos[i, 1] < crotch_y + 0.002:
                part[i] = 3 if pos[i, 0] > 0 else 4
        md.extras['crotch_y'] = crotch_y
        log('%s: crotch y=%.3f' % (md.name, crotch_y))
    # torso-like: cylinder around the body axis
    sel = part == 0
    u[sel] = 0.5 + np.arctan2(pos[sel, 0], pos[sel, 2] - zc) / (2 * np.pi)
    for side, pid in (('l', 1), ('r', 2)):
        sel = part == pid
        if not sel.any():
            continue
        best_t, best_u = arm_param(ch, pos[sel], side)
        param[sel] = best_t; u[sel] = best_u
    for side, pid in (('l', 3), ('r', 4)):
        sel = part == pid
        if not sel.any():
            continue
        cx, _, cz = heads['thigh_' + side]
        u[sel] = 0.5 + np.arctan2(pos[sel, 0] - cx, pos[sel, 2] - cz) / (2 * np.pi)
    # loops: connected components of "ring" edges (both ends at ~ the same param)
    tri = md.indices
    e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    e = np.sort(e, axis=1); e = np.unique(e, axis=0)
    e = e[part[e[:, 0]] == part[e[:, 1]]]
    dp_ = np.abs(param[e[:, 0]] - param[e[:, 1]])
    maxd = np.zeros(n)
    np.maximum.at(maxd, e[:, 0], dp_); np.maximum.at(maxd, e[:, 1], dp_)
    ring = dp_ < 0.3 * np.minimum(maxd[e[:, 0]], maxd[e[:, 1]])
    parent = np.arange(n)
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for a, b in e[ring]:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
    def collect():
        roots = np.array([find(i) for i in range(n)])
        loop = np.zeros(n, dtype=np.float64)
        for r in np.unique(roots):
            sel = roots == r
            loop[sel] = param[sel].mean()
        return roots, loop
    # merge fragments of the same ring (split where a row tilts): neighbours with ~equal means
    for _ in range(3):
        roots, loop = collect()
        merged = 0
        tol = 0.3 * np.minimum(maxd[e[:, 0]], maxd[e[:, 1]])
        for (a, b), tl in zip(e, tol):
            if roots[a] != roots[b] and abs(loop[a] - loop[b]) < tl:
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[rb] = ra; merged += 1
        if not merged:
            break
    roots, loop = collect()
    loop = loop.astype(np.float32)
    spans = [float(param[roots == r].max() - param[roots == r].min()) for r in np.unique(roots)]
    md.loop = loop
    md.part = part
    # make the helper's region ids consistent with its parts (runtime classifies by region)
    if mode == 'parts':
        legs = np.array([r.startswith(('thigh', 'shin', 'foot')) for r in reg])
        torso_lo = REGIONS.index('torso_lo')
        md.region[(part == 0) & legs] = torso_lo
        for side, pid in (('l', 3), ('r', 4)):
            md.region[(part == pid) & ~legs] = REGIONS.index('thigh_hi_' + side)
    md.uvs = np.stack([u, param], axis=1).astype(np.float32)
    log('%s: %d verts, %d loops, max loop span %.1f mm, median %.1f mm' % (
        md.name, n, len(spans), 1000 * max(spans), 1000 * float(np.median(spans))))

def split_uv_seams(md):
    """Duplicate vertices of triangles that straddle the u = 0/1 wrap so the texture does not smear."""
    uv = md.uvs.copy(); tri = md.indices.copy()
    extra = {}  # src vertex -> duplicated index
    cols = {'positions': md.positions, 'normals': md.normals, 'joints': md.joints, 'weights': md.weights,
            'src_index': md.src_index, 'base_index': md.base_index, 'region': md.region, 'loop': md.loop, 'part': md.part}
    new_rows = {k: [] for k in cols}
    n = len(uv); uv_new = []
    for t in tri:
        us = uv[t, 0]
        if us.max() - us.min() > 0.5:
            for k in range(3):
                if us[k] < 0.5:
                    v = int(t[k])
                    if v not in extra:
                        extra[v] = n + len(uv_new)
                        uv_new.append([uv[v, 0] + 1.0, uv[v, 1]])
                        for name, arr in cols.items():
                            new_rows[name].append(arr[v])
                    t[k] = extra[v]
    if uv_new:
        md.uvs = np.concatenate([uv, np.array(uv_new, np.float32)])
        for name, arr in cols.items():
            setattr(md, name, np.concatenate([arr, np.array(new_rows[name], dtype=arr.dtype)]))
        md.indices = tri
    log('%s: split %d seam vertices' % (md.name, len(uv_new)))

# ----------------------------------------------------------------------------- regions

def compute_regions(ch, md, shoes_delete_sets):
    """Per unified vertex region id (see REGIONS)."""
    n = len(md.positions)
    bone_names = [b.name for b in ch.bones]
    # dominant bone
    dom = md.joints[np.arange(n), np.argmax(md.weights, axis=1)]
    reg = np.zeros(n, dtype=np.uint8)
    # bone rest geometry (world)
    heads = {b.name: ch.to_world(b.getRestHeadPos()[None, :])[0] for b in ch.bones}
    tails = {b.name: ch.to_world(b.getRestTailPos()[None, :])[0] for b in ch.bones}
    def seg_t(p, bname):
        a = heads[bname]; d = tails[bname] - a
        return float(np.dot(p - a, d) / max(1e-9, np.dot(d, d)))
    neck_y = landmarks(ch)['neck'][1]
    for i in range(n):
        bname = bone_names[int(dom[i])]
        r = BONE_REGION.get(bname)
        if r is None:  # fingers
            r = 'hand_l' if bname.endswith('_l') else 'hand_r'
        if r == 'torso_up' and md.positions[i][1] > neck_y - 0.03:
            r = 'head'  # neck base / shoulder tops stay visible: skin shows inside an open collar
        if r in ('uarm_l', 'uarm_r'):
            t = seg_t(md.positions[i], 'upperarm_' + r[-1])
            r = ('uarm_hi_' if t < 0.5 else 'uarm_lo_') + r[-1]
        elif r in ('thigh_l', 'thigh_r'):
            t = seg_t(md.positions[i], 'thigh_' + r[-1])
            r = ('thigh_hi_' if t < 0.5 else 'thigh_lo_') + r[-1]
        reg[i] = REGIONS.index(r)
    # feet: only vertices hidden by *every* shoe count as 'foot' (safe to hide when shoes are on);
    # the rest of the foot behaves like the shin (visible with shorts).
    if shoes_delete_sets and hasattr(md, 'base_index'):
        inter = None
        for s in shoes_delete_sets:
            inter = set(s.tolist()) if inter is None else inter & set(s.tolist())
        inter = np.array(sorted(inter), dtype=np.int64) if inter else np.array([], dtype=np.int64)
        hidden = np.isin(md.base_index, inter)
        for side in ('l', 'r'):
            fi = REGIONS.index('foot_' + side); si = REGIONS.index('shin_' + side)
            foot = reg == fi
            reg[foot & ~hidden] = si
    md.region = reg
    return reg

# ----------------------------------------------------------------------------- animation

class PoseSource:
    """Posed source skeleton: world rotation W(b) (rest->pose) + rest direction per mapped bone."""
    def __init__(self):
        self.W = {}
        self.dir = {}

def soft1_sources(bvhfile):
    """Per-frame PoseSource for a MakeHuman 1.0 (soft1 rig) BVH such as walk1.bvh."""
    joints = bvhfile.getJoints()
    # rest directions (world; soft1 BVH joints have identity rest rotation)
    dirs = {}
    for j in joints:
        child = None
        pref = SOFT1_DIR_CHILD.get(j.name, 'auto')
        if pref is None:
            child = None
        elif pref != 'auto':
            child = bvhfile.getJointByCanonicalName(pref)
        else:
            for c in j.children:
                if not c.name.startswith('__'):
                    child = c; break
            if child is None and j.children:
                child = j.children[0]
        if child is not None and np.linalg.norm(child.offset) > 1e-6:
            dirs[j.name] = normalize(np.asarray(child.offset, dtype=np.float64))
        else:
            dirs[j.name] = np.array([0, 1, 0], dtype=np.float64)
    frames = []
    for f in range(bvhfile.frameCount):
        G_ = {}
        def rec(j, parentG):
            L = np.asarray(j.matrixPoses[f][:3, :3], dtype=np.float64)
            Gj = parentG @ L
            G_[j.name] = Gj
            for c in j.children:
                rec(c, Gj)
        for root in joints:
            if root.parent is None:
                rec(root, np.identity(3))
        src = PoseSource(); src.W = G_; src.dir = dirs
        frames.append(src)
    return frames

def default_rig_source(ch, bvhfile, frame=0):
    """PoseSource from a MakeHuman 1.1+ (default rig) BVH pose, via the base skeleton."""
    track = bvhfile.createAnimationTrack(ch.base_skel)
    ch.base_skel.setPose(track.getAtFramePos(frame))
    src = PoseSource()
    for b in ch.base_skel.getBones():
        src.W[b.name] = b.matPoseGlobal[:3, :3].astype(np.float64) @ b.matRestGlobal[:3, :3].astype(np.float64).T
        src.dir[b.name] = normalize(np.asarray(b.getRestTailPos() - b.getRestHeadPos(), dtype=np.float64))
    ch.base_skel.setToRestPose()
    return src

def default_rig_mapping(ch, src):
    """ge bone -> the reference (default-rig) bone whose rest direction matches best."""
    mapping = {}
    for b in ch.bones:
        refs = [r for r in (b.reference_bones or []) if r in src.W]
        if b.name == 'pelvis' and 'root' in refs:
            mapping[b.name] = 'root'; continue
        if not refs:
            mapping[b.name] = None; continue
        d_g = normalize(np.asarray(b.getRestTailPos() - b.getRestHeadPos(), dtype=np.float64))
        refs.sort(key=lambda r: -float(np.dot(d_g, src.dir.get(r, d_g))))
        mapping[b.name] = refs[0]
    return mapping

def ge_world_rotations(ch, src, mapping):
    """World rotations W(b) for all game-engine bones from a PoseSource.
    mapping: ge bone name -> source bone name (or None)."""
    W = {}
    for b in ch.bones:
        s = mapping.get(b.name)
        if s is not None and s in src.W:
            d_g = normalize(np.asarray(b.getRestTailPos() - b.getRestHeadPos(), dtype=np.float64))
            d_s = src.dir.get(s, d_g)
            Q = rot_between(d_g, d_s) if s not in ('Root', 'root') else np.identity(3)
            W[b.name] = src.W[s] @ Q
        else:
            W[b.name] = W[b.parent.name] if b.parent else np.identity(3)
    return W

def relatives_from_world(ch, W):
    R = {}
    for b in ch.bones:
        Wp = W[b.parent.name] if b.parent else np.identity(3)
        R[b.name] = Wp.T @ W[b.name]
    return R

def world_from_relatives(ch, R):
    W = {}
    for b in ch.bones:
        Wp = W[b.parent.name] if b.parent else np.identity(3)
        W[b.name] = Wp @ R[b.name]
    return W

def local_transforms(ch, W, root_translation=None):
    """Pose the ge skeleton with world rotations W and return per-bone (t, q) node transforms (metres)."""
    n = len(ch.bones)
    pose = np.zeros((n, 4, 4), dtype=np.float32)
    for i, b in enumerate(ch.bones):
        pose[i] = np.identity(4)
        Wp = W[b.parent.name] if b.parent else np.identity(3)
        pose[i, :3, :3] = (Wp.T @ W[b.name]).astype(np.float32)
    ch.skel.setPose(pose)
    out = []
    for i, b in enumerate(ch.bones):
        L = np.asarray(b.matRestRelative, dtype=np.float64) @ np.asarray(b.matPose, dtype=np.float64)
        t, q = mat_to_trs(L)
        t = t * SCALE
        if b.parent is None:
            t[1] -= ch.ground_y * SCALE
            if root_translation is not None:
                t = t + root_translation
        out.append((t, q))
    ch.skel.setToRestPose()
    return out

def rest_transforms(ch):
    out = []
    for b in ch.bones:
        t, q = mat_to_trs(np.asarray(b.matRestRelative, dtype=np.float64))
        t = t * SCALE
        if b.parent is None:
            t[1] -= ch.ground_y * SCALE
        out.append((t, q))
    return out

def rot_axis(axis, deg):
    return tm.rotation_matrix(math.radians(deg), normalize(np.asarray(axis, dtype=np.float64)))[:3, :3]

def scale_rotation(R, s):
    m = np.identity(4); m[:3, :3] = R
    ang, axis, _ = tm.rotation_from_matrix(m)
    return tm.rotation_matrix(ang * s, axis)[:3, :3]

def flex_axis(ch, bone_name, toward=(0, 0, 1)):
    """World axis that rotates bone 'bone_name' (rest direction) toward 'toward'."""
    b = ch.skel.getBone(bone_name)
    d = normalize(np.asarray(b.getRestTailPos() - b.getRestHeadPos(), dtype=np.float64))
    a = np.cross(d, np.asarray(toward, dtype=np.float64))
    if np.linalg.norm(a) < 1e-6:
        a = np.array([1, 0, 0], dtype=np.float64)
    return normalize(a)

def descendants(ch, bone_name):
    out = []
    def rec(b):
        for c in b.children:
            out.append(c.name); rec(c)
    rec(ch.skel.getBone(bone_name))
    return out

def rotate_subtree_world(ch, W, bone_name, axis_world, deg):
    """Rotate a bone and everything below it about a world axis through the bone's head."""
    Rw = rot_axis(axis_world, deg)
    for n in [bone_name] + descendants(ch, bone_name):
        W[n] = Rw @ W[n]
    return W

def posed_dir(ch, W, bone_name):
    b = ch.skel.getBone(bone_name)
    d = normalize(np.asarray(b.getRestTailPos() - b.getRestHeadPos(), dtype=np.float64))
    return normalize(W[bone_name] @ d)

WALK_LEAN_FIX = -9.0   # degrees about X on spine_01 (mocap walk is a bit hunched)
WALK_NECK_FIX = -5.0

def build_walk_frames(ch):
    bf = bvh.load(dp('animations/walks/walk1.bvh'))
    srcs = soft1_sources(bf)
    frames = []
    for src in srcs:
        W = ge_world_rotations(ch, src, SOFT1_MAP)
        rotate_subtree_world(ch, W, 'spine_01', [1, 0, 0], WALK_LEAN_FIX)
        rotate_subtree_world(ch, W, 'neck_01', [1, 0, 0], WALK_NECK_FIX)
        frames.append(W)
    return frames, 1.0 / bf.frameTime

def build_run_frames(ch, walk_frames):
    """Derive a run cycle from the walk: bigger leg swing, forward lean, bent arms."""
    out = []
    for W0 in walk_frames:
        R = relatives_from_world(ch, W0)
        for side in ('l', 'r'):
            R['thigh_' + side] = scale_rotation(R['thigh_' + side], 1.35)
            R['calf_' + side] = scale_rotation(R['calf_' + side], 1.25)
            R['upperarm_' + side] = scale_rotation(R['upperarm_' + side], 1.2)
        W = world_from_relatives(ch, R)
        for side in ('l', 'r'):
            # bend the elbow ~75 degrees so the forearm swings forward/up of the upper arm
            du = posed_dir(ch, W, 'upperarm_' + side)
            axis = np.cross(du, [0, 0, 1])
            if np.linalg.norm(axis) < 1e-6:
                axis = np.array([1, 0, 0], dtype=np.float64)
            rotate_subtree_world(ch, W, 'lowerarm_' + side, axis, 75)
        rotate_subtree_world(ch, W, 'spine_01', [1, 0, 0], 14)   # lean into the run
        rotate_subtree_world(ch, W, 'neck_01', [1, 0, 0], -8)
        out.append(W)
    return out

def build_idle_frames(ch, n_frames=48, fps=12.0):
    """Relaxed standing pose with breathing / weight shift baked in."""
    bf = bvh.load(dp('poses/standing02.bvh'))
    src = default_rig_source(ch, bf)
    mapping = default_rig_mapping(ch, src)
    base = ge_world_rotations(ch, src, mapping)
    frames = []
    for i in range(n_frames):
        ph = 2 * math.pi * i / n_frames
        R = relatives_from_world(ch, base)
        br = math.sin(ph * 2)            # 2 breaths per loop (4s loop -> 2s per breath)
        sway = math.sin(ph)
        R['spine_02'] = rot_axis([1, 0, 0], -1.2 * br) @ R['spine_02']
        R['spine_03'] = rot_axis([1, 0, 0], -1.0 * br) @ R['spine_03']
        R['clavicle_l'] = rot_axis([0, 0, 1], -1.5 * br) @ R['clavicle_l']
        R['clavicle_r'] = rot_axis([0, 0, 1], 1.5 * br) @ R['clavicle_r']
        R['neck_01'] = rot_axis([1, 0, 0], 1.0 * br) @ R['neck_01']
        R['head'] = rot_axis([0, 1, 0], 2.5 * sway) @ rot_axis([0, 0, 1], 1.0 * math.sin(ph * 0.5 + 1)) @ R['head']
        R['pelvis'] = rot_axis([0, 0, 1], 0.8 * sway) @ R['pelvis']
        frames.append(world_from_relatives(ch, R))
    return frames, fps

# ----------------------------------------------------------------------------- glTF writer

class GLB:
    def __init__(self):
        self.buf = bytearray()
        self.views = []; self.accessors = []
        self.j = {'asset': {'version': '2.0', 'generator': 'GIST mh_export (MakeHuman CC0 assets)'},
                  'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
                  'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'skins': [],
                  'materials': [], 'animations': [], 'bufferViews': self.views, 'accessors': self.accessors}

    def _pad(self, n=4):
        while len(self.buf) % n:
            self.buf.append(0)

    def view(self, data: bytes, target=None, stride=None):
        self._pad()
        off = len(self.buf); self.buf += data
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target: v['target'] = target
        if stride: v['byteStride'] = stride
        self.views.append(v)
        return len(self.views) - 1

    def accessor(self, arr, ctype, atype, target=None, minmax=False, normalized=False):
        arr = np.ascontiguousarray(arr)
        vi = self.view(arr.tobytes(), target)
        a = {'bufferView': vi, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': atype}
        if normalized: a['normalized'] = True
        if minmax:
            a['min'] = [float(x) for x in np.min(arr, axis=0).reshape(-1)]
            a['max'] = [float(x) for x in np.max(arr, axis=0).reshape(-1)]
        self.accessors.append(a)
        return len(self.accessors) - 1

    def morph_vec3(self, deltas, count, thresh=3e-4):
        """Morph target POSITION deltas: normalized int16 (KHR_mesh_quantization), sparse when sparse."""
        deltas = np.asarray(deltas, dtype=np.float64)
        q = np.clip(np.round(deltas * 32767.0), -32767, 32767).astype(np.int16)
        nz = np.nonzero(np.abs(deltas).max(axis=1) > thresh)[0]
        if len(nz) == 0:
            nz = np.array([0], dtype=np.int64)
        if len(nz) > 0.5 * count:
            return self.accessor(q, 5122, 'VEC3', minmax=True, normalized=True)
        idx_t = 5123 if count < 65535 else 5125
        idx = nz.astype(np.uint16 if idx_t == 5123 else np.uint32)
        vals = q[nz]
        ivi = self.view(np.ascontiguousarray(idx).tobytes())
        vvi = self.view(np.ascontiguousarray(vals).tobytes())
        a = {'componentType': 5122, 'normalized': True, 'count': int(count), 'type': 'VEC3',
             'min': [int(x) for x in np.minimum(vals.min(axis=0), 0)], 'max': [int(x) for x in np.maximum(vals.max(axis=0), 0)],
             'sparse': {'count': int(len(nz)), 'indices': {'bufferView': ivi, 'componentType': idx_t},
                        'values': {'bufferView': vvi}}}
        self.accessors.append(a)
        return len(self.accessors) - 1

    def finish(self, path):
        self._pad()
        self.j['buffers'] = [{'byteLength': len(self.buf)}]
        js = json.dumps(self.j, separators=(',', ':'), default=_json_default).encode('utf-8')
        while len(js) % 4:
            js += b' '
        total = 12 + 8 + len(js) + 8 + len(self.buf)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
            f.write(struct.pack('<II', len(self.buf), 0x004E4942)); f.write(bytes(self.buf))
        return total

def add_material(g, name, kind):
    """Materials carry no textures (assigned at runtime from manifest) but sensible PBR params."""
    m = {'name': name, 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.0, 'roughnessFactor': 0.75}}
    if kind in ('hair', 'brow', 'lash', 'eye'):
        m['alphaMode'] = 'BLEND' if kind != 'hair' else 'MASK'
        if kind == 'hair': m['alphaCutoff'] = 0.4
        m['doubleSided'] = True
    if kind == 'eye':
        m['pbrMetallicRoughness']['roughnessFactor'] = 0.25
    if kind == 'skin':
        m['pbrMetallicRoughness']['roughnessFactor'] = 0.62
    if kind == 'shoes':
        m['pbrMetallicRoughness']['roughnessFactor'] = 0.7
    g.j['materials'].append(m)
    return len(g.j['materials']) - 1

def add_mesh(g, md: MeshData, mat_index, skin_index, target_names):
    # weights as normalized uint8 whose four entries sum to exactly 255
    w = np.asarray(md.weights, dtype=np.float64)
    w = w / np.maximum(1e-9, w.sum(axis=1, keepdims=True))
    wq = np.floor(w * 255.0 + 0.5).astype(np.int32)
    fix = 255 - wq.sum(axis=1)
    wq[np.arange(len(wq)), np.argmax(wq, axis=1)] += fix
    wq = np.clip(wq, 0, 255).astype(np.uint8)
    nq = np.clip(np.round(np.asarray(md.normals, dtype=np.float64) * 127.0), -127, 127).astype(np.int8)
    uv = np.asarray(md.uvs, dtype=np.float64)
    attrs = {
        'POSITION': g.accessor(md.positions.astype(np.float32), 5126, 'VEC3', 34962, minmax=True),
        'NORMAL': g.accessor(nq, 5120, 'VEC3', 34962, normalized=True),
        'JOINTS_0': g.accessor(md.joints.astype(np.uint8), 5121, 'VEC4', 34962),
        'WEIGHTS_0': g.accessor(wq, 5121, 'VEC4', 34962, normalized=True),
    }
    if uv.min() >= 0.0 and uv.max() <= 1.0:
        attrs['TEXCOORD_0'] = g.accessor(np.round(uv * 65535.0).astype(np.uint16), 5123, 'VEC2', 34962, normalized=True)
    else:
        attrs['TEXCOORD_0'] = g.accessor(uv.astype(np.float32), 5126, 'VEC2', 34962)
    if md.region is not None:
        attrs['_REGION'] = g.accessor(md.region.astype(np.uint8).reshape(-1, 1), 5121, 'SCALAR', 34962)
    if getattr(md, 'loop', None) is not None:
        attrs['_LOOP'] = g.accessor(md.loop.astype(np.float32).reshape(-1, 1), 5126, 'SCALAR', 34962)
    n = len(md.positions)
    idx = md.indices.reshape(-1)
    if n < 65535:
        ia = g.accessor(idx.astype(np.uint16), 5123, 'SCALAR', 34963)
    else:
        ia = g.accessor(idx.astype(np.uint32), 5125, 'SCALAR', 34963)
    prim = {'attributes': attrs, 'indices': ia, 'material': mat_index, 'mode': 4}
    names = [t for t in target_names if t in md.targets]
    if names:
        prim['targets'] = [{'POSITION': g.morph_vec3(md.targets[t], n, thresh=(1e-3 if md.name.startswith(('hair_', 'shoes_')) else 3e-4))} for t in names]
    mesh = {'name': md.name, 'primitives': [prim]}
    if names:
        mesh['extras'] = {'targetNames': names}
        mesh['weights'] = [0.0] * len(names)
    g.j['meshes'].append(mesh)
    mi = len(g.j['meshes']) - 1
    node = {'name': md.name, 'mesh': mi, 'skin': skin_index}
    g.j['nodes'].append(node)
    ni = len(g.j['nodes']) - 1
    g.j['scenes'][0]['nodes'].append(ni)
    return ni

def add_skeleton(g, ch):
    """Bone nodes (rest pose) + skin with inverse bind matrices. Returns (skin index, node ids)."""
    rest = rest_transforms(ch)
    base = len(g.j['nodes'])
    ids = []
    for i, b in enumerate(ch.bones):
        t, q = rest[i]
        g.j['nodes'].append({'name': b.name, 'translation': [float(x) for x in t], 'rotation': [float(x) for x in q]})
        ids.append(base + i)
    for i, b in enumerate(ch.bones):
        kids = [base + ch.bone_index[c.name] for c in b.children]
        if kids:
            g.j['nodes'][base + i]['children'] = kids
    root_ids = [base + i for i, b in enumerate(ch.bones) if b.parent is None]
    g.j['scenes'][0]['nodes'].extend(root_ids)
    # inverse bind matrices (world rest -> bone), in metres with the ground shift
    ibms = np.zeros((len(ch.bones), 4, 4), dtype=np.float32)
    for i, b in enumerate(ch.bones):
        Mw = np.asarray(b.matRestGlobal, dtype=np.float64).copy()  # rotation unchanged,
        Mw[1, 3] -= ch.ground_y                                     # translation -> metres
        Mw[:3, 3] *= SCALE
        ibms[i] = np.linalg.inv(Mw).T  # column-major
    acc = g.accessor(ibms.reshape(len(ch.bones), 16), 5126, 'MAT4')
    g.j['skins'].append({'name': 'rig', 'joints': ids, 'inverseBindMatrices': acc, 'skeleton': root_ids[0]})
    return len(g.j['skins']) - 1, ids

def add_animation(g, ch, name, frames, fps, bone_ids, loop_pad=True):
    """frames: list of per-bone (t,q) lists."""
    n = len(frames)
    if loop_pad:
        frames = frames + [frames[0]]
        n += 1
    times = (np.arange(n, dtype=np.float32) / fps).astype(np.float32)
    ta = g.accessor(times.reshape(-1, 1), 5126, 'SCALAR', minmax=True)
    anim = {'name': name, 'samplers': [], 'channels': []}
    for bi, b in enumerate(ch.bones):
        qs = np.array([fr[bi][1] for fr in frames], dtype=np.float32)
        # keep quaternion hemisphere continuous
        for k in range(1, n):
            if np.dot(qs[k], qs[k - 1]) < 0:
                qs[k] *= -1
        qa = g.accessor(qs, 5126, 'VEC4')
        anim['samplers'].append({'input': ta, 'output': qa, 'interpolation': 'LINEAR'})
        anim['channels'].append({'sampler': len(anim['samplers']) - 1, 'target': {'node': bone_ids[bi], 'path': 'rotation'}})
        ts = np.array([fr[bi][0] for fr in frames], dtype=np.float32)
        if np.ptp(ts, axis=0).max() > 1e-5:
            tacc = g.accessor(ts, 5126, 'VEC3')
            anim['samplers'].append({'input': ta, 'output': tacc, 'interpolation': 'LINEAR'})
            anim['channels'].append({'sampler': len(anim['samplers']) - 1, 'target': {'node': bone_ids[bi], 'path': 'translation'}})
    g.j['animations'].append(anim)

# ----------------------------------------------------------------------------- textures

def export_texture(src, dst_name, size, fmt, quality=82):
    os.makedirs(TEX_DIR, exist_ok=True)
    dst = os.path.join(TEX_DIR, dst_name)
    if os.path.exists(dst):
        return dst_name
    im = Image.open(src)
    if fmt == 'jpg':
        im = im.convert('RGB')
    else:
        im = im.convert('RGBA')
    if im.size[0] > size:
        im = im.resize((size, size), Image.LANCZOS)
    if fmt == 'jpg':
        im.save(dst, 'JPEG', quality=quality, optimize=True)
    elif fmt == 'webp':
        im.save(dst, 'WEBP', quality=quality, method=6)
    else:
        im.save(dst, 'PNG', optimize=True)
    return dst_name

def mean_color(path, size=256):
    im = Image.open(path).convert('RGBA').resize((size, size))
    a = np.asarray(im, dtype=np.float32)
    w = a[:, :, 3:4] / 255.0
    rgb = (a[:, :, :3] * w).sum(axis=(0, 1)) / max(1.0, w.sum())
    return [round(float(x) / 255.0, 4) for x in rgb]

def material_texture(mhmat_path):
    base = os.path.dirname(mhmat_path)
    for line in open(mhmat_path, encoding='utf-8', errors='ignore'):
        parts = line.strip().split()
        if len(parts) >= 2 and parts[0] == 'diffuseTexture':
            return os.path.normpath(os.path.join(base, parts[1]))
    return None

# ----------------------------------------------------------------------------- main export

def export_sex(sex, manifest):
    ch = Character(sex)
    cfg = ch.cfg
    t0 = time.time()
    # --- base meshes
    shoes = {}
    for sid, path in SHOES.items():
        shoes[sid] = proxy_mesh(ch, path, 'Clothes', 'shoes_' + sid, 'shoes_' + sid)
    shoe_dels = [m.extras['delete_verts'] for m in shoes.values() if m.extras['delete_verts'] is not None]
    body = body_mesh(ch)
    compute_regions(ch, body, shoe_dels)
    lo = proxy_mesh(ch, cfg['lo'], 'Proxymeshes', 'body_lo', 'skin')
    lo.base_index = None
    compute_regions(ch, lo, None)
    eyes = proxy_mesh(ch, 'eyes/low-poly/low-poly.mhpxy', 'Eyes', 'eyes', 'eye')
    brows = proxy_mesh(ch, cfg['brows'], 'Eyebrows', 'brows', 'brow')
    lashes = proxy_mesh(ch, cfg['lashes'], 'Eyelashes', 'lashes', 'lash')
    hairs = {hid: proxy_mesh(ch, HAIR[hid], 'Hair', 'hair_' + hid, 'hair_' + hid) for hid in cfg['hair']}
    helpers = {k: helper_mesh(ch, k) for k in HELPERS}
    marks = {'base': landmarks(ch), 'variants': {}}
    log('meshes extracted in %.1fs: body %d verts / %d tris, lo %d verts' % (
        time.time() - t0, len(body.positions), len(body.indices), len(lo.positions)))

    # --- morph targets
    all_meshes = [body, lo, eyes, brows, lashes] + list(hairs.values()) + list(shoes.values()) + list(helpers.values())
    variants = dict(cfg['variants']); variants.update(FACE_VARIANTS)
    base_body = body.positions.copy()
    for vname, values in variants.items():
        t = time.time()
        ch.apply(values)
        world = ch.to_world(ch.h.meshData.coord)
        new_body = world[body.base_index].astype(np.float32)
        body.targets[vname] = new_body - base_body
        marks['variants'][vname] = landmarks(ch)
        for md in all_meshes[1:]:
            is_face = vname.startswith('face_')
            if md.name.startswith('hair_') and not is_face:
                continue  # hair follows face shape only (head barely changes with body type)
            if md.name.startswith('shoes_') and is_face:
                continue
            if md.name in ('tights', 'skirt') and is_face:
                continue
            if md.name == 'scalp' and not is_face:
                continue
            if md.base_index is not None:
                new = world[md.base_index].astype(np.float32)
            else:
                new = proxy_coords(ch, md)[md.src_index].astype(np.float32)
            md.targets[vname] = new - md.positions
        log('  variant %s: body max delta %.1f mm (%.1fs)' % (vname, 1000 * np.abs(body.targets[vname]).max(), time.time() - t))
    ch.apply({})  # back to base
    bounds = region_bounds(ch, body, variants)

    # --- animations
    t = time.time()
    walk_W, walk_fps = build_walk_frames(ch)
    run_W = build_run_frames(ch, walk_W)
    idle_W, idle_fps = build_idle_frames(ch)
    walk = [local_transforms(ch, W) for W in walk_W]
    run = [local_transforms(ch, W) for W in run_W]
    idle = [local_transforms(ch, W) for W in idle_W]
    log('animations built in %.1fs (walk %d frames @ %.0f fps)' % (time.time() - t, len(walk), walk_fps))

    # --- textures
    tex = {}
    tex['skin_' + sex] = export_texture(dp('skins/textures', cfg['skin']), 'skin_%s_dark.jpg' % sex, 1024, 'jpg')
    tex['skin_%s_light' % sex] = export_texture(dp('skins/textures', cfg['skin_light']), 'skin_%s_light.jpg' % sex, 1024, 'jpg')
    mats = {'skin': {'kind': 'skin', 'tex': tex['skin_' + sex], 'tex_light': tex['skin_%s_light' % sex], 'mean': {
        'dark': mean_color(os.path.join(TEX_DIR, tex['skin_' + sex])),
        'light': mean_color(os.path.join(TEX_DIR, tex['skin_%s_light' % sex]))}}}
    def pxy_tex(md, kind, name, size, fmt):
        src = material_texture(md.proxy.material_file) if md.proxy.material_file else None
        if src and os.path.exists(src):
            return export_texture(src, name, size, fmt)
        log('WARN no texture for', md.name, md.proxy.material_file)
        return None
    mats['eye'] = {'kind': 'eye', 'tex': export_texture(dp('eyes/materials/brown_eye.png'), 'eye_brown.png', 256, 'png')}
    mats['brow'] = {'kind': 'brow', 'tex': pxy_tex(brows, 'brow', 'brow_%s.png' % sex, 256, 'png')}
    mats['lash'] = {'kind': 'lash', 'tex': pxy_tex(lashes, 'lash', 'lash_%s.png' % sex, 256, 'png')}
    for hid, md in hairs.items():
        mats['hair_' + hid] = {'kind': 'hair', 'tex': pxy_tex(md, 'hair', 'hair_%s.webp' % hid, 1024, 'webp')}
    for sid, md in shoes.items():
        mats['shoes_' + sid] = {'kind': 'shoes', 'tex': pxy_tex(md, 'shoes', 'shoes_%s.webp' % sid, 512, 'webp')}
    mats['cloth'] = {'kind': 'cloth', 'tex': None}

    # --- write glb
    g = GLB()
    skin_index, bone_ids = add_skeleton(g, ch)
    mat_ids = {}
    for mname, info in mats.items():
        mat_ids[mname] = add_material(g, mname, info['kind'])
    target_names = list(variants.keys())
    for md in all_meshes:
        add_mesh(g, md, mat_ids[md.material], skin_index, target_names)
    add_animation(g, ch, 'walk', walk, walk_fps, bone_ids)
    add_animation(g, ch, 'run', run, walk_fps, bone_ids)
    add_animation(g, ch, 'idle', idle, idle_fps, bone_ids)
    g.j['asset']['extras'] = {
        'source': 'MakeHuman 1.2.0 assets (CC0 1.0)', 'regions': REGIONS,
        'bones': [b.name for b in ch.bones], 'height_m': round(ch.h.getHeightCm() / 100, 3),
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, 'human_%s.glb' % sex)
    size = g.finish(out)
    log('wrote %s (%.2f MB)' % (out, size / 1e6))
    manifest['models'][sex] = {
        'file': 'human_%s.glb' % sex, 'bytes': size, 'height_m': round(ch.h.getHeightCm() / 100, 3),
        'hair': list(hairs.keys()), 'shoes': list(shoes.keys()), 'morphs': target_names, 'landmarks': marks,
        'region_bounds': bounds, 'crotch_y': round(float(helpers['tights'].extras.get('crotch_y', 0.0)), 4),
        'materials': mats, 'animations': {'walk': {'fps': walk_fps, 'frames': len(walk)}, 'run': {'fps': walk_fps, 'frames': len(run)}, 'idle': {'fps': idle_fps, 'frames': len(idle)}},
        'stats': {m.name: {'verts': int(len(m.positions)), 'tris': int(len(m.indices))} for m in all_meshes},
    }
    return manifest

def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    mpath = os.path.join(OUT_DIR, 'manifest.json')
    manifest = {'regions': REGIONS, 'models': {}}
    if os.path.exists(mpath):
        try:
            manifest = json.load(open(mpath))
            manifest.setdefault('models', {})
        except Exception:
            pass
    manifest['regions'] = REGIONS
    manifest['license'] = 'Characters baked from MakeHuman 1.2.0 assets (CC0 1.0 Universal)'
    for sex in (['f', 'm'] if which == 'all' else [which]):
        export_sex(sex, manifest)
        json.dump(manifest, open(mpath, 'w'), indent=1, default=_json_default)
    log('manifest written', mpath)

if __name__ == '__main__':
    main()
