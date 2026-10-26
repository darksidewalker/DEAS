"""Exercise the vendored cluster scanner with inconsistent seek reads, not a full decoder."""
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

if sys.platform != 'linux':
    sys.exit('Linux-only vendored GStreamer C diagnostic; requires pkg-config and cc.')

source = Path(sys.argv[1]).read_text(encoding='utf-8')
start = source.index('static GstFlowReturn\ngst_matroska_demux_search_cluster (')
end = source.index('/* Three states', start)
scanner = source[start:end]
fixture = r'''
#include <gst/gst.h>
#include <gst/base/gstbytereader.h>
#undef GST_LOG_OBJECT
#undef GST_DEBUG_OBJECT
#undef GST_ERROR_OBJECT
#define GST_LOG_OBJECT(...) ((void)0)
#define GST_DEBUG_OBJECT(...) ((void)0)
#define GST_ERROR_OBJECT(...) ((void)0)
#define GST_MATROSKA_ID_CLUSTER 0x1f43b675
#define GST_EBML_SIZE_UNKNOWN G_MAXUINT64
/* The scanner needs only these fields; IO is deliberately inconsistent. */
typedef struct { gint64 offset; GstPad *sinkpad; } Common;
typedef struct { GstElement element; Common common; GArray *clusters; gint64 first_cluster_offset; } GstMatroskaDemux;
static guint reads, mode;
static guint64 previous;
static gboolean direction;
static GstFlowReturn pull(GstPad *pad, guint64 offset, guint count, GstBuffer **buf) {
  (void)pad; (void)count;
  if (reads++) {
    g_assert_true(direction ? offset > previous : offset < previous);
    return GST_FLOW_EOS;
  }
  previous = offset + 8;
  const guint8 bytes[] = {0,0,0,0,0,0,0,0,0x1f,0x43,0xb6,0x75,0xff,0,0,0};
  *buf = gst_buffer_new_allocate(NULL, sizeof bytes, NULL);
  gst_buffer_fill(*buf, 0, bytes, sizeof bytes);
  return GST_FLOW_OK;
}
static GstFlowReturn peek(Common *common, GstElement *element, guint32 *id, guint64 *length, guint *needed) {
  (void)common; (void)element;
  *id = mode == 0 ? 0 : GST_MATROSKA_ID_CLUSTER;
  *length = GST_EBML_SIZE_UNKNOWN; *needed = 5;
  return mode == 2 ? GST_FLOW_ERROR : GST_FLOW_OK;
}
static gint gst_matroska_cluster_compare(gconstpointer a, gconstpointer b, gpointer unused) {
  (void)unused; return (*(const gint64*)a > *(const gint64*)b) - (*(const gint64*)a < *(const gint64*)b);
}
#define gst_pad_pull_range pull
#define gst_matroska_read_common_peek_id_length_pull peek
'''
main = r'''
int main(int argc, char **argv) {
  gst_init(&argc, &argv);
  for (guint which = 0; which < 3; which++) {
    for (guint forward = 0; forward < 2; forward++) {
      GstMatroskaDemux demux = {0};
      demux.common.offset = 123; demux.first_cluster_offset = -1;
      gint64 pos = 200000;
      mode = which; reads = 0; direction = forward;
      GstFlowReturn ret = gst_matroska_demux_search_cluster(&demux, &pos, direction);
      g_assert_cmpint(ret, ==, which == 1 ? GST_FLOW_OK : GST_FLOW_EOS);
      g_assert_cmpuint(reads, ==, which == 1 ? 1 : 2);
      g_assert_cmpint(demux.common.offset, ==, 123);
    }
  }
  return 0;
}
'''
flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'gstreamer-base-1.0'], text=True))
# The caller controls TMPDIR; the repository never receives generated source/binaries.
with tempfile.TemporaryDirectory(prefix='deas-matroska-') as temp:
    path = Path(temp)
    (path/'scanner.c').write_text(fixture + scanner + main, encoding='utf-8')
    subprocess.run(['cc', '-Wall', '-Wextra', '-Werror', '-Wno-sign-compare', '-o', str(path/'scanner'), str(path/'scanner.c'), *flags], check=True)
    subprocess.run([str(path/'scanner')], check=True, timeout=10)
print('PASS: invalid cluster IDs and failed reads rescan with progress; valid clusters remain usable (both directions).')
