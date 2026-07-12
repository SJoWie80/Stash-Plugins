import json, sys, urllib.parse, urllib.request, xml.etree.ElementTree as ET

def val(args, key, default=""):
    x = args.get(key, default)
    return x.get("str", x.get("value", default)) if isinstance(x, dict) else x

def request(url, data=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "Stash Spotweb Studio"})
    with urllib.request.urlopen(req, timeout=30) as r: return r.read()

def main():
    p = json.loads(sys.stdin.read() or "{}"); a = p.get("args") or {}; action = val(a, "action", "search")
    if action == "add":
        base, key, sab, sabkey = val(a,"spotwebUrl").rstrip("/"), val(a,"spotwebKey"), val(a,"sabUrl").rstrip("/"), val(a,"sabKey")
        nzb = val(a,"nzbUrl"); name = val(a,"nzbName")
        q = {"mode":"addurl","name":nzb,"nzbname":name,"output":"json","apikey":sabkey}
        raw = request(sab + "/api?" + urllib.parse.urlencode(q)); return {"output": json.loads(raw.decode("utf-8"))}
    base, key, query = val(a,"spotwebUrl").rstrip("/"), val(a,"spotwebKey"), val(a,"query")
    queries = [query]
    compact = "".join(query.split())
    if compact and compact.lower() != query.lower(): queries.append(compact)
    items=[]; seen=set()
    for search_query in queries:
      params = {"t":"search","q":search_query,"apikey":key,"o":"xml","limit":val(a,"limit","100")}
      raw = request(base + "/api?" + urllib.parse.urlencode(params)); root = ET.fromstring(raw)
      for x in root.findall(".//item"):
        def text(n): return (x.findtext(n) or "").strip()
        link = text("enclosure") or text("link")
        enc = x.find("enclosure")
        if enc is not None: link = enc.attrib.get("url", link)
        ident=text("guid") or link
        if ident in seen: continue
        seen.add(ident)
        size=text("size") or (enc.attrib.get("length", "") if enc is not None else "")
        items.append({"id":ident,"title":text("title"),"pubDate":text("pubDate"),"size":size,"nzbUrl":link})
    items.sort(key=lambda x: ((x.get("title") or "").lower(), x.get("pubDate") or ""), reverse=False)
    return {"output":{"items":items}}

try: print(json.dumps(main()))
except Exception as e: print(json.dumps({"error":str(e)}))
