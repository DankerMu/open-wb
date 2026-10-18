#!/usr/bin/env bash
# CI job office-sidecar（office-preview「转换 sidecar 实现与镜像」场景「镜像与 compose 的标志（CI e2e）」、
# 「转换隔离边界」场景「链接资源不被取回」第一组；change office-convert-sandbox design D10）。
# 前提：同一 job 里已 `npm run build --workspace server` 与 `docker build -t workbuddy-converter:ci converter/`；
# 镜像 tag 只活在本 runner 上，本脚本不推送、不发布任何东西（owner B9）。
# (1) spool 0700 + jobs/ 0700 + <cache>/pdf 0700（没有 app 的 preparePreviewCache 替它建）；
# (2) 以与 converter/compose.yml 逐项相同的隔离标志起 sidecar，等 heartbeat ≤ 30 s；
# (3) 本机 http 监听器 + python3 zipfile 生成的外链图片 docx（TargetMode="External"，不进仓库）；
# (4) 产品代码 server/dist/preview/office.js 的 createOfficeConverter 转换 → 0 次请求、PDF 无图；
# (5) 对照：同一镜像 --network host 直接跑 soffice → ≥ 1 次请求且 PDF 含图（红 = fixture 失效）；
# (6) docker stop → 退出 0、jobs/ 无残留。runner uid 不在镜像 /etc/passwd 里（顺带实测 design D6）。
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
port=18019
doc=linked-image.docx
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/office-sidecar.XXXXXX")"
spool="$work/spool"; cache="$work/cache"; ctl="$work/control"; www="$work/www"; access="$work/access.log"
cid=""; lpid=""
cleanup() {
  local rc=$?
  [ -z "$lpid" ] || kill "$lpid" 2>/dev/null || true
  if [ -n "$cid" ]; then
    [ "$rc" -eq 0 ] || docker logs "$cid" >&2 2>&1 || true
    docker rm -f "$cid" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
die() { echo "office-sidecar: FAIL $*" >&2; exit 1; }
requests() { grep -c '"GET ' "$access" || true; }
images() { grep -a -c '/Subtype */Image' "$1" || true; }
uid="$(id -u)"; gid="$(id -g)"
[ "$uid" -ne 0 ] || die "must not run as root"

# (1) spool 与缓存目录，全部 0700、属 runner 用户。
umask 077
mkdir -m 0700 "$spool" "$spool/jobs" "$cache" "$cache/pdf" "$ctl" "$www"

# design D6 的未测项：runner uid 必须不在镜像的 /etc/passwd 里，这一跑才算实测了它。
passwd_uids="$(docker run --rm --network none --entrypoint cut workbuddy-converter:ci -d: -f3 /etc/passwd)"
if grep -qx "$uid" <<<"$passwd_uids"; then die "runner uid $uid is in the image /etc/passwd; design D6 is not exercised"; fi

# (2) 标志与 converter/compose.yml 逐项相同（scripts/test-ci-harness.sh 把这一行钉成字面）。
cid="$(docker run -d --network none --read-only --tmpfs /tmp --init --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" -v "$spool:/spool" workbuddy-converter:ci)"
start=$SECONDS
until [ -f "$spool/heartbeat" ]; do
  [ $((SECONDS - start)) -lt 30 ] || die "no heartbeat within 30 s"
  sleep 0.5
done
echo "office-sidecar: heartbeat after $((SECONDS - start)) s"

# (3) 记录请求的监听器（TCP 连上即算就绪，空连接不产生日志行）与外链图片 docx。
python3 - "$www/probe.png" "$work/$doc" "http://127.0.0.1:$port/probe.png" <<'PY'
import struct, sys, zipfile, zlib
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
raw = b"".join(b"\x00" + b"\xff\x00\x00" * 16 for _ in range(16))
with open(sys.argv[1], "wb") as png:
    png.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 16, 16, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
ext = '<a:ext cx="914400" cy="914400"/>'
pic = ('<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="probe.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="rId2"/>'
       '<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/>' + ext + '</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>')
drawing = ('<w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="probe"/><a:graphic>'
           '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' + pic + '</a:graphicData></a:graphic></wp:inline></w:drawing>')
document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + ns + '><w:body><w:p><w:r><w:t>linked image probe</w:t></w:r></w:p>'
            '<w:p><w:r>' + drawing + '</w:r></w:p></w:body></w:document>')
rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
pkg = "http://schemas.openxmlformats.org/package/2006/relationships"
with zipfile.ZipFile(sys.argv[2], "w") as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr("_rels/.rels", f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{pkg}"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr("word/document.xml", document)
    z.writestr("word/_rels/document.xml.rels", f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{pkg}"><Relationship Id="rId2" Type="{rel}/image" Target="{sys.argv[3]}" TargetMode="External"/></Relationships>')
PY
python3 -m http.server --bind 127.0.0.1 --directory "$www" "$port" >/dev/null 2>"$access" &
lpid=$!
until python3 -c 'import socket, sys; socket.create_connection(("127.0.0.1", int(sys.argv[1])), 1).close()' "$port" 2>/dev/null; do
  kill -0 "$lpid" 2>/dev/null || die "http listener did not start"
  sleep 0.2
done

# (4) 走产品代码：bash 里没有第二份 spool 协议实现。
pdf="$(node --input-type=module -e '
import { pathToFileURL } from "node:url";
const [mod, spoolDir, cacheDir, input] = process.argv.slice(1);
const { createOfficeConverter } = await import(pathToFileURL(mod).href);
const converter = createOfficeConverter({ spoolDir, cacheDir, timeoutMs: 60000 });
try {
  process.stdout.write(await converter.convert(input));
} catch (error) {
  process.stderr.write(`convert failed: ${error.kind ?? "unknown"}\n`);
  process.exitCode = 1;
} finally {
  await converter.close();
}
' "$root/server/dist/preview/office.js" "$spool" "$cache" "$work/$doc")" || die "createOfficeConverter did not convert the docx"
[ -f "$pdf" ] || die "no PDF from the product path"
[ "${pdf#"$cache/pdf/"}" != "$pdf" ] || die "the PDF is not under <cache>/pdf"
[ "$(stat -c %u "$pdf")" = "$uid" ] || die "PDF is not owned by the runner uid"
[ -z "$(ls -A "$spool/jobs")" ] || die "jobs/ is not empty after the conversion"
r="$(requests)"; n="$(images "$pdf")"
echo "office-sidecar: product path (sidecar): requests=$r images=$n"
[ "$r" -eq 0 ] || die "the listener saw $r request(s) from the product path"
[ "$n" -eq 0 ] || die "the product PDF has $n image(s)"

# (5) 对照：只把网络换成 host、绕过 sidecar 直接跑 soffice（镜像 ENTRYPOINT 是 sidecar，必须覆盖）。
cp "$work/$doc" "$ctl/$doc"
docker run --rm --network host --entrypoint /usr/bin/soffice -e HOME=/job -v "$ctl:/job" --user "$uid:$gid" --read-only --tmpfs /tmp --init --cap-drop ALL --security-opt no-new-privileges workbuddy-converter:ci \
  --headless --norestore --nolockcheck --nodefault --nofirststartwizard -env:UserInstallation=file:///job/profile --convert-to pdf --outdir /job/out "/job/$doc" >&2 \
  || die "the control soffice run failed"
[ -f "$ctl/out/${doc%.docx}.pdf" ] || die "the control produced no PDF"
r="$(requests)"; n="$(images "$ctl/out/${doc%.docx}.pdf")"
echo "office-sidecar: control (--network host): requests=$r images=$n"
if [ "$r" -lt 1 ] || [ "$n" -lt 1 ]; then die "the control did not fetch the linked image: the fixture is invalid (not a product failure)"; fi

# (6) docker stop：tini 把 SIGTERM 转给 sidecar，它杀在途进程组并以 0 退出。
docker stop "$cid" >/dev/null
state="$(docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' "$cid")"
logs="$(docker logs "$cid" 2>&1)"
docker rm "$cid" >/dev/null; cid=""
[ "$state" = "false 0" ] || die "the sidecar did not exit 0 after docker stop (running/exit: $state)"
grep -q '"event":"convert".*"result":"done"' <<<"$logs" || die "the sidecar log has no done line"
case "$logs" in *"$work"* | *linked-image* | */*) die "the sidecar log carries a path or the input name" ;; esac
[ -z "$(ls -A "$spool/jobs")" ] || die "jobs/ is not empty after docker stop"
echo "office-sidecar: PASS"
