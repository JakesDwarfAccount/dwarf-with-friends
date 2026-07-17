#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WS2 T0 offline reconstructor + diff. Run with:
#   python tools/ws2/reconstruct.py tools/ws2/sample
import json, os, struct, sys
from PIL import Image

LAYERS = [  # (name, elem_size, kind)  kind in {"tex","flag","tree"}
 ("background",4,"tex"),("floor_flag",8,"flag"),("background_two",4,"tex"),("liquid_flag",4,"flag"),
 ("spatter_flag",4,"flag"),("spatter",4,"tex"),("ramp_flag",8,"flag"),("shadow_flag",4,"flag"),
 ("building_one",4,"tex"),("item",4,"tex"),("vehicle",4,"tex"),("vermin",4,"tex"),
 ("left_creature",4,"tex"),("main",4,"tex"),("right_creature",4,"tex"),("building_two",4,"tex"),
 ("projectile",4,"tex"),("high_flow",4,"tex"),("top_shadow",4,"tex"),("signpost",4,"tex"),
 ("designation",4,"tex"),("interface",4,"tex"),("upleft_creature",4,"tex"),("up_creature",4,"tex"),
 ("upright_creature",4,"tex"),("tree_plus_one",2,"tree")]
# Back-to-front composite order by layer name (scout section 5). Flags handled separately.
DRAW_ORDER = ["background","background_two","building_one","spatter","item","vehicle","vermin",
 "left_creature","main","right_creature","upleft_creature","up_creature","upright_creature",
 "building_two","projectile","high_flow","top_shadow","signpost","designation","interface"]

def load_frame(path):
    d = open(path,"rb").read(); off=0
    magic,ver,dx,dy,ox,oy,z = struct.unpack_from("<IIiiiii", d, off); off+=28
    assert magic==0x44544644 and ver==1, (hex(magic),ver)
    arrays={}
    tiles=dx*dy
    for name,elem,kind in LAYERS:
        got=d[off]; off+=1; assert got==elem,(name,got,elem)
        fmt={2:"<h",4:"<i",8:"<q"}[elem]
        vals=[struct.unpack_from(fmt,d,off+j*elem)[0] for j in range(tiles)]
        off+=tiles*elem
        arrays[name]=vals
    return dx,dy,arrays

def load_atlas(adir):
    idx=json.load(open(os.path.join(adir,"index.json")))["tiles"]
    cache={}
    def get(tp):
        s=str(tp)
        if s not in idx: return None
        if tp in cache: return cache[tp]
        w=idx[s]["w"]; h=idx[s]["h"]
        raw=open(os.path.join(adir,f"tex_{tp}.rgba"),"rb").read()
        im=Image.frombytes("RGBA",(w,h),raw)
        cache[tp]=im; return im
    return get, idx

def tile_px(atlas_idx):
    # Assume a dominant tile size = the modal (w,h) among atlas entries.
    from collections import Counter
    c=Counter((v["w"],v["h"]) for v in atlas_idx.values())
    return c.most_common(1)[0][0]

def reconstruct(dx,dy,arrays,get,tw,th,use_flags):
    img=Image.new("RGBA",(dx*tw,dy*th),(0,0,0,255))
    for x in range(dx):
        for y in range(dy):
            i=x*dy+y
            px,py=x*tw,y*th
            for name in DRAW_ORDER:
                tp=arrays[name][i]
                if tp<=0: continue
                spr=get(tp)
                if spr is None: continue
                s=spr if spr.size==(tw,th) else spr.resize((tw,th))
                img.paste(s,(px,py),s)
            if use_flags:
                # PASS 2 hook: apply liquid_flag / ramp_flag / shadow_flag effects here once
                # bit meanings are known. On first run this block is a no-op so pass1==pass2
                # unless a flag bit is present, which is exactly what we are measuring.
                apply_flags(img,px,py,tw,th,arrays,i)
    return img

def apply_flags(img,px,py,tw,th,arrays,i):
    # Deliberately empty until bit semantics are correlated (Step 8). Intentionally a no-op.
    return

def diff(a,b):
    a=a.convert("RGB"); b=b.convert("RGB").resize(a.size)
    out=Image.new("RGB",a.size)
    ap=a.load(); bp=b.load(); op=out.load()
    for y in range(a.size[1]):
        for x in range(a.size[0]):
            r=abs(ap[x,y][0]-bp[x,y][0]); g=abs(ap[x,y][1]-bp[x,y][1]); bl=abs(ap[x,y][2]-bp[x,y][2])
            m=max(r,g,bl); op[x,y]=(m, 0, 255-m)   # red = mismatch, blue = match
    return out

def main(sample):
    dx,dy,arrays=load_frame(os.path.join(sample,"frame.bin"))
    get,idx=load_atlas(os.path.join(sample,"atlas"))
    tw,th=tile_px(idx)
    gt=Image.open(os.path.join(sample,"ground_truth.png"))
    r1=reconstruct(dx,dy,arrays,get,tw,th,False); r1.save(os.path.join(sample,"recon_texpos.png"))
    r2=reconstruct(dx,dy,arrays,get,tw,th,True);  r2.save(os.path.join(sample,"recon_flags.png"))
    diff(r1,gt).save(os.path.join(sample,"diff_texpos.png"))
    diff(r2,gt).save(os.path.join(sample,"diff_flags.png"))
    # Per-flag presence report: which tiles have nonzero flag bits, to correlate with diff.
    for name,_,kind in LAYERS:
        if kind!="flag": continue
        nz=sum(1 for v in arrays[name] if v)
        bits=0
        for v in arrays[name]:
            bits|=v
        print(f"{name}: {nz} nonzero tiles, OR-of-bits=0x{bits:x}")
    print(f"tile size {tw}x{th}, grid {dx}x{dy}")

if __name__=="__main__":
    main(sys.argv[1] if len(sys.argv)>1 else "tools/ws2/sample")
