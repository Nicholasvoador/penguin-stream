#!/usr/bin/env python3
"""Host-only metadata/decoder verification. Never emits media content."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, obj):
    path.write_text(json.dumps(obj, indent=2) + '\n')
    path.chmod(0o600)


def probe(path, out):
    with out.with_suffix('.stderr.log').open('w') as err:
        result = subprocess.run([
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_packets', '-show_frames', '-count_frames',
            '-show_entries',
            'packet=pos,size,flags:frame=key_frame,pict_type:stream=codec_name,width,height,nb_read_frames',
            '-of', 'json', str(path)], stdout=subprocess.PIPE, stderr=err, check=True)
    out.write_bytes(result.stdout)
    assert out.with_suffix('.stderr.log').stat().st_size == 0, 'ffprobe reported decode errors'
    return json.loads(result.stdout)


def records(p, kind):
    return [x for x in p['packets_and_frames'] if x['type'] == kind]


def nal_types(data):
    return [data[m.end()] & 31 for m in re.finditer(b'\x00\x00(?:\x00)?\x01', data) if m.end() < len(data)]


def prepare(source, root):
    st = source.stat()
    assert stat.S_ISREG(st.st_mode) and st.st_size == 750242 and stat.S_IMODE(st.st_mode) == 0o644
    fixture = root / 'source.h264'
    with source.open('rb') as src, fixture.open('xb') as dst:
        os.chmod(fixture, 0o600)
        shutil.copyfileobj(src, dst)
    data = fixture.read_bytes()
    assert len(data) == 750242 and digest(data) == digest(source.read_bytes())
    p = probe(fixture, root / 'source-probe.json')
    frames, packets = records(p, 'frame'), records(p, 'packet')
    assert p['streams'][0]['codec_name'] == 'h264' and len(frames) == 2
    assert int(p['streams'][0]['nb_read_frames']) == 2 and len(packets) == 2
    offset, units = 0, []
    for packet in packets:
        pos, size = int(packet['pos']), int(packet['size'])
        assert pos == offset and size > 0
        types = nal_types(data[pos:pos + size])
        units.append({'offset': pos, 'bytes': size, 'keyframe': 'K' in packet['flags'], 'nalTypes': types})
        offset += size
    assert offset == len(data)
    types = units[0]['nalTypes']
    assert 7 in types and 8 in types and 5 in types and not ({1, 2, 3, 4} & set(types)), 'first AU must contain SPS/PPS and only IDR VCL'
    assert types.index(7) < types.index(5) and types.index(8) < types.index(5)
    assert frames[0]['key_frame'] == 1 and frames[0]['pict_type'] == 'I'
    repeated = data * 10
    expected = root / 'expected.h264'
    expected.write_bytes(repeated)
    expected.chmod(0o600)
    ep = probe(expected, root / 'expected-probe.json')
    assert int(ep['streams'][0]['nb_read_frames']) == 20 and len(records(ep, 'frame')) == 20
    manifest = {'sourceBytes': len(data), 'sourceSha256': digest(data), 'repeat': 10,
                'sourceDecodedFrames': 2, 'expectedDecodedFrames': 20, 'transportUnits': 20,
                'expectedBytes': len(repeated), 'expectedSha256': digest(repeated), 'units': units,
                'maxPayload': 12000, 'chunkDelayMs': 8}
    save(root / 'manifest.json', manifest)


def verify(root):
    m = json.loads((root / 'manifest.json').read_text())
    received = root / 'received' / 'received.h264'
    assert stat.S_IMODE(received.stat().st_mode) == 0o600
    data = received.read_bytes()
    assert len(data) == m['expectedBytes'] and digest(data) == m['expectedSha256'], 'received bytes/hash mismatch'
    assert data == (root / 'source.h264').read_bytes() * m['repeat'], 'independent exact-byte comparison failed'
    p = probe(received, root / 'received-probe.json')
    assert int(p['streams'][0]['nb_read_frames']) == m['expectedDecodedFrames']
    assert len(records(p, 'frame')) == m['expectedDecodedFrames']
    results = {}
    for role in ['host', 'client']:
        lines = (root / (role + '.log')).read_text().splitlines()
        matches = [json.loads(x[7:]) for x in lines if x.startswith('RESULT:')]
        assert len(matches) == 1 and matches[0]['ok'], role + ' failed'
        results[role] = matches[0]
    h, c = results['host'], results['client']
    topology = json.loads((root / 'topology.json').read_text())
    ht, ct = h['transport'], c['transport']
    assert ht['connected'] and ct['connected'] and ht['policy'] == ct['policy'] == 'all'
    assert ht['relayed'] and ht['localType'] == 'relay'
    assert ct['remoteAddress'] in [topology['relayA'], topology['relayB']] and ct['remoteAddress'] != topology['host']
    assert ht['remoteAddress'] != topology['client'] or ht['localType'] == 'relay'
    assert h['sasHash'] == c['sasHash'] and h['sasHash']
    chunks = sum((u['bytes'] + m['maxPayload'] - 18) // (m['maxPayload'] - 17) for u in m['units']) * m['repeat']
    assert h['chunks'] == c['chunks'] == chunks
    assert h['units'] == c['units'] == m['transportUnits']
    assert h['bytes'] == c['bytes'] == m['expectedBytes']
    assert h['sha256'] == c['sha256'] == m['expectedSha256']
    assert h['rejected'] == c['rejected'] == 0
    assert c['reassembly'] == {'completed': 20, 'dropped': 0, 'duplicates': 0, 'malformed': 0, 'bytes': m['expectedBytes']}
    s = json.loads((root / 'turn-stats.json').read_text())
    assert s['allocations'] >= 2 and s['relayedToPeer'] > 0 and s['relayedToClient'] > 0
    assert s['bytesRelayed'] >= m['expectedBytes'] and s['authFailures'] == 0
    for name in ['network-a.json', 'network-b.json']:
        n = json.loads((root / name).read_text())[0]
        assert n['internal'] is True and n['options']['isolate'] == 'true'
    for role in ['host', 'client', 'relay']:
        routes = json.loads((root / (role + '-routes.json')).read_text())
        assert routes['noDefaultRoute'] and routes['ipv6DefaultAbsent']
    isolation = json.loads((root / 'isolation.json').read_text())
    assert all(isolation.values()) and len(isolation) == 8
    summary = {'ok': True, 'media': m, 'host': h, 'client': c, 'turn': s,
               'isolation': isolation, 'decodedFrames': len(records(p, 'frame')),
               'receivedBytes': len(data), 'receivedSha256': digest(data), 'topology': topology}
    save(root / 'summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1] == 'prepare':
        prepare(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == 'verify':
        verify(Path(sys.argv[2]))
    else:
        raise SystemExit('unknown mode')
