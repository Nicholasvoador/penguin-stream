#!/usr/bin/env python3
"""Deterministic allowlisted source + optional local Linux engine bundle; no secrets."""
from pathlib import Path
import hashlib, io, json, tarfile
root = Path(__file__).resolve().parents[1]
files = []
for folder in ['node/src', 'node/test', 'media/src', 'turn/src', 'scripts', 'docs', 'tests']:
    files.extend(p for p in (root/folder).rglob('*') if p.is_file() and not p.is_symlink() and 'artifacts' not in p.parts and p.suffix in {'.sh','.mjs','.js','.html','.css','.cpp','.h','.py','.md','.ps1'})
for name in ['README.md','SECURITY.md','LIMITATIONS.md','LICENSE','THIRD-PARTY.md','package.json','package-lock.json','media/CMakeLists.txt','penguin-stream.bat']:
    p = root/name
    if not p.is_file() or p.is_symlink(): raise SystemExit(f'Missing or unsafe file: {name}')
    files.append(p)
items = {str(p.relative_to(root)): p.read_bytes() for p in sorted(set(files))}
binary=root/'media/build/ps-media'
if binary.is_file() and not binary.is_symlink(): items['media/build/ps-media']=binary.read_bytes()
manifest={name:hashlib.sha256(data).hexdigest() for name,data in sorted(items.items())}
items['MANIFEST.sha256.json']=(json.dumps(manifest,indent=2)+'\n').encode()
out=root/'dist/penguin-stream-experimental-linux.tar'
out.parent.mkdir(exist_ok=True)
with tarfile.open(out,'w') as tar:
    for name,data in sorted(items.items()):
        entry=tarfile.TarInfo('penguin-stream/'+name)
        entry.size=len(data); entry.mtime=0
        entry.mode=0o755 if name in ['media/build/ps-media','scripts/package.py'] else 0o644
        tar.addfile(entry,io.BytesIO(data))
with tarfile.open(out) as tar:
    for member in tar.getmembers():
        name=member.name
        assert '..' not in Path(name).parts
        assert not any(x in Path(name).parts for x in ['artifacts','.git','node_modules'])
        assert not name.endswith(('.h264','.framed','.log'))
        assert member.isfile()
print(json.dumps({'archive':str(out),'files':len(items),'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'note':'Not a self-contained installer: npm ci and matching system shared libraries required.'},indent=2))
