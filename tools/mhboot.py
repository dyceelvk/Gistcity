"""Bootstrap MakeHuman 1.2.0 python modules headless (no Qt/OpenGL).
Expects MH_ROOT env var (default /home/user/.cache/mh/ex/makehuman)."""
import os, sys, types
MH_ROOT = os.environ.get('MH_ROOT', '/home/user/.cache/mh/ex/makehuman')
os.chdir(MH_ROOT)
for p in ['lib', 'core', 'shared', 'apps', 'apps/gui', 'plugins']:
    sys.path.insert(0, os.path.join(MH_ROOT, p))
mh = types.ModuleType('makehuman')
mh.getVersionDigitsStr = lambda: '1.2.0'
mh.getVersionStr = lambda *a, **k: '1.2.0'
mh.getVersion = lambda: (1, 2, 0)
mh.getBasemeshVersion = lambda: 'hm08'
mh.getShortVersion = lambda *a, **k: '1.2.0'
mh.getCopyrightMessage = lambda *a, **k: ''
mh.isRelease = lambda: True
mh.isBuild = lambda: True
sys.modules['makehuman'] = mh

def patch_numpy2():
    """MakeHuman 1.2 predates numpy 2: ndarray.tostring() and np.bool are gone."""
    import re
    for rel in ['core/files3d.py', 'shared/proxy.py', 'lib/image.py', 'lib/unique.py']:
        p = os.path.join(MH_ROOT, rel)
        if not os.path.exists(p):
            continue
        src = open(p, encoding='utf-8').read()
        new = src.replace('.tostring()', '.tobytes()').replace('np.bool)', 'bool)')
        if new != src:
            open(p, 'w', encoding='utf-8').write(new)
patch_numpy2()

class _NoopApp:
    """Minimal stand-in for the MakeHuman Qt application object (G.app)."""
    def __init__(self):
        self.selectedHuman = None
        self._settings = {'realtimeNormalUpdates': False, 'preloadTargets': False, 'units': 'metric',
                          'sliderImages': False, 'cameraAutoZoom': False}
    def progress(self, *a, **k): pass
    def getSetting(self, name, default=None): return self._settings.get(name, default)
    def setSetting(self, name, value): self._settings[name] = value
    def callAsync(self, fn, *a, **k): return fn(*a, **k)
    def callEvent(self, *a, **k): pass
    def redraw(self): pass
    def prompt(self, *a, **k): return True
    def statusPersist(self, *a, **k): pass
    def status(self, *a, **k): pass
    def __getattr__(self, name):
        return lambda *a, **k: None

from core import G as _G  # noqa: E402
_G.app = _NoopApp()

class _License:
    """Stand-in for makehuman.LicenseInfo (assets are CC0; we only need the API surface)."""
    def __init__(self):
        self.author = 'MakeHuman Team'; self.license = 'CC0'; self.homepage = 'http://www.makehumancommunity.org'; self.copyright = ''
    def copy(self): return _License()
    def asDict(self): return {'author': self.author, 'license': self.license, 'homepage': self.homepage, 'copyright': self.copyright}
    def fromJson(self, d):
        for k in ('author', 'license', 'homepage', 'copyright'):
            if k in d: setattr(self, k, d[k])
        return self
    def updateFromComment(self, *a, **k): pass
    def toNumpyString(self):
        import numpy as np
        return np.frombuffer(b'', dtype='S1'), np.array([], dtype='uint32')
    def fromNumpyString(self, *a, **k): return self
    def isCustomized(self): return False
    def __str__(self): return self.license
mh.getAssetLicense = lambda *a, **k: _License()
mh.LicenseInfo = _License
