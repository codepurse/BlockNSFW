#!/usr/bin/env python3
"""Convert Marqo/nsfw-image-detection-384 into the TFJS GraphModel the
extension's vit384 classifier loads.

Produces two things that are deployed to DIFFERENT places:

  models/vit384/model.json      -> committed to this repo and shipped in the
                                   extension package. It is the execution graph
                                   plus the weights manifest (~350 KB).

  group1-shard*of*.bin          -> published to the URL in
                                   shared/ai-image-models.js (data/models/vit384/
                                   in the codepurse/BlockNSFW repo), NOT bundled.
                                   ~22 MB of fp32 weights, fetched on first use
                                   and cached locally by the extension.

That split is deliberate: bundling 22 MB would grow the store download ~5x for
an opt-in feature most users never enable, while keeping the graph in the
package means the part that describes execution stays reviewable and the
weight fetch is unambiguously data.

Environment: needs Python 3.11 or 3.12 — TensorFlow (and therefore the
`tensorflowjs` converter) does not publish wheels for 3.13+. Create a
dedicated venv; do not install this into the repo's main environment.

TWO environments are required, because the stages want incompatible pins:
onnx/onnx2tf need a recent TensorFlow (for a recent `ml_dtypes`), while
`tensorflowjs` still pins TensorFlow 2.15 (whose older `ml_dtypes` then breaks
`import onnx`). They share nothing but the SavedModel on disk, so run them
separately with --stage.

    # Stage 1 - export: timm -> ONNX -> TF SavedModel
    uv venv --python 3.11 .venv-export
    uv pip install --python .venv-export torch --index-url https://download.pytorch.org/whl/cpu
    uv pip install --python .venv-export timm onnx onnxscript onnx2tf tf_keras onnx_graphsurgeon sng4onnx onnxsim ai_edge_litert psutil
    .venv-export/Scripts/python tools/convert_vit384.py --stage export --out-dir build/vit384

    # Stage 2 - tfjs: SavedModel -> TFJS GraphModel
    uv venv --python 3.11 .venv-tfjs
    uv pip install --python .venv-tfjs "tensorflowjs>=4.22"
    .venv-tfjs/Scripts/python tools/convert_vit384.py --stage tfjs --out-dir build/vit384

Then:
  1. Copy build/vit384/model.json  -> models/vit384/model.json  (commit here)
  2. Publish build/vit384/*.bin    -> data/models/vit384/       (other repo)
  3. If the weights change, bump VIT384_WEIGHTS_VERSION in
     shared/ai-image-models.js so clients re-download instead of serving a
     stale cache entry.
  4. Verify the input contract still matches shared/vit-classifier.js:
     384x384x3 NHWC, (x/255 - 0.5) / 0.5, two logits, NSFW at index 0.

Model provenance: Marqo/nsfw-image-detection-384, Apache-2.0, a timm
`vit_tiny_patch16_384` fine-tune. See THIRD_PARTY_NOTICES.md.
"""

import argparse
import json
import os
import subprocess
import sys

HF_MODEL_ID = "Marqo/nsfw-image-detection-384"
INPUT_SIZE = 384
NUM_CLASSES = 2


def fail(message):
    print("ERROR: " + message, file=sys.stderr)
    sys.exit(1)


def check_python():
    if sys.version_info >= (3, 13):
        fail(
            "Python %d.%d is too new: TensorFlow has no wheels for 3.13+, so "
            "the tensorflowjs converter cannot be installed. Use Python 3.11 "
            "or 3.12 in a dedicated venv." % sys.version_info[:2]
        )


def export_onnx(out_dir):
    """timm checkpoint -> ONNX, with a fixed 384x384 NCHW input."""
    import torch
    import timm

    print("==> loading %s from Hugging Face" % HF_MODEL_ID)
    model = timm.create_model("hf_hub:" + HF_MODEL_ID, pretrained=True)
    model.eval()

    cfg = model.default_cfg
    print("    architecture: %s" % cfg.get("architecture", "?"))
    print("    input size:   %s" % (cfg.get("input_size"),))
    print("    num classes:  %s" % model.num_classes)
    if model.num_classes != NUM_CLASSES:
        fail("expected %d classes, model reports %d" % (NUM_CLASSES, model.num_classes))

    # The extension normalizes with mean=std=0.5 (see shared/vit-classifier.js).
    # If upstream ever changes its preprocessing, the JS must change with it —
    # so assert rather than silently produce a mis-normalized model.
    mean = tuple(round(float(v), 3) for v in cfg.get("mean", ()))
    std = tuple(round(float(v), 3) for v in cfg.get("std", ()))
    print("    mean/std:     %s %s" % (mean, std))
    if mean != (0.5, 0.5, 0.5) or std != (0.5, 0.5, 0.5):
        fail(
            "upstream preprocessing changed to mean=%s std=%s; update `norm` in "
            "shared/ai-image-models.js and toInputTensor() in "
            "shared/vit-classifier.js to match before shipping" % (mean, std)
        )

    onnx_path = os.path.join(out_dir, "model.onnx")
    dummy = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    print("==> exporting ONNX -> %s" % onnx_path)
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=["input"],
        output_names=["logits"],
        # 17, not 13: a ViT emits LayerNormalization, which only exists from
        # opset 17. Asking for 13 makes the exporter attempt a downgrade that
        # fails ("No Previous Version of LayerNormalization exists").
        opset_version=17,
        dynamic_axes=None,  # fixed batch of 1: the extension scores one image
    )
    return onnx_path


def disable_onednn():
    """Must run before TensorFlow is imported (it reads this at import time)."""
    os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"


def onnx_to_saved_model(onnx_path, out_dir):
    """ONNX (NCHW) -> TF SavedModel (NHWC).

    Uses onnx2tf rather than onnx-tf: onnx-tf is unmaintained and pulls in
    tensorflow-addons, which no longer builds against current TensorFlow.
    onnx2tf also rewrites NCHW to NHWC natively, which matters here — tfjs
    wants NHWC and a canvas already hands us NHWC, so doing the transpose at
    conversion time keeps it out of the extension's per-image hot path.

    `output_signaturedefs` is required: tensorflowjs_converter loads the
    SavedModel through its serving signature, and without one it fails with a
    bare "signature not found".
    """
    import numpy as np
    import onnx2tf

    saved_model_dir = os.path.join(out_dir, "saved_model")

    # onnx2tf runs a dummy inference to settle shapes, and for any 4D 3-channel
    # input it unconditionally fetches a sample-image .npy from its GitHub
    # release (see download_test_image_data in onnx2tf/utils/common_functions).
    # That fetch is not guarded by any flag, and when it returns an error page
    # instead of a .npy, numpy reports it as "contains pickled (object) data"
    # and the whole conversion dies. It reads a local copy from the CWD when one
    # exists, so write one: the contents only feed a shape-inference pass, never
    # the exported weights.
    calibration_name = "calibration_image_sample_data_20x128x128x3_float32.npy"
    calibration_path = os.path.join(out_dir, calibration_name)
    if not os.path.isfile(calibration_path):
        print("==> writing local %s (avoids onnx2tf's sample-image download)"
              % calibration_name)
        rng = np.random.default_rng(0)
        np.save(calibration_path,
                rng.random((20, 128, 128, 3), dtype=np.float32))

    print("==> converting ONNX -> SavedModel %s" % saved_model_dir)
    previous_cwd = os.getcwd()
    os.chdir(out_dir)  # onnx2tf looks for the calibration file in the CWD
    try:
        onnx2tf.convert(
            input_onnx_file_path=os.path.abspath(onnx_path),
            output_folder_path=os.path.abspath(saved_model_dir),
            output_signaturedefs=True,
            non_verbose=True,
        )
    finally:
        os.chdir(previous_cwd)
    return saved_model_dir


def converter_env(out_dir):
    """Environment for the tensorflowjs converter subprocess.

    tensorflowjs imports `tensorflow_decision_forests` unconditionally, but
    TF-DF has no Windows build at all — its loader looks for an `inference.so`
    that is never shipped, so `import tensorflowjs.converters` dies on Windows
    before it looks at our model.

    We convert a Vision Transformer, not a decision forest, so shadowing that
    package with an empty stub is safe. The stub goes on PYTHONPATH rather than
    into site-packages: PYTHONPATH is searched first, so this works whether or
    not the real TF-DF is installed, and it leaves the venv untouched.
    """
    stub_root = os.path.join(out_dir, "_tfjs_stubs")
    stub_pkg = os.path.join(stub_root, "tensorflow_decision_forests")
    os.makedirs(stub_pkg, exist_ok=True)
    init_py = os.path.join(stub_pkg, "__init__.py")
    if not os.path.isfile(init_py):
        print("==> stubbing tensorflow_decision_forests (no Windows build)")
        with open(init_py, "w", encoding="utf-8") as fh:
            fh.write(
                '"""Stub: tensorflowjs imports TF-DF unconditionally and TF-DF\n'
                'has no Windows build. Not used when converting a ViT."""\n'
                "__version__ = '0.0.0-stub'\n"
            )

    env = dict(os.environ)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = stub_root + (os.pathsep + existing if existing else "")

    # Without this, TensorFlow's grappler fuses the ViT's layer norms into
    # `_MklLayerNorm` — a oneDNN-specific op with no tfjs kernel — and the
    # conversion fails with "Unsupported Ops in the model after optimization:
    # _MklLayerNorm". oneDNN is an inference speed-up for TF on CPU and buys
    # us nothing here, since the graph is going to run in a browser.
    env["TF_ENABLE_ONEDNN_OPTS"] = "0"
    return env


def saved_model_to_tfjs(saved_model_dir, out_dir, quantize):
    """SavedModel -> TFJS GraphModel shards."""
    tfjs_dir = os.path.join(out_dir, "tfjs")
    os.makedirs(tfjs_dir, exist_ok=True)
    # Invoked as a module rather than via the `tensorflowjs_converter` shim:
    # the shim lives in the venv's Scripts/ directory, which is not on PATH
    # when the venv's python is called by absolute path.
    cmd = [
        sys.executable, "-m", "tensorflowjs.converters.converter",
        "--input_format=tf_saved_model",
        "--output_format=tfjs_graph_model",
        "--signature_name=serving_default",
        "--saved_model_tags=serve",
    ]
    if quantize:
        # Roughly 22 MB -> 5.6 MB, at some accuracy cost. Measure before
        # shipping a quantized build: this model's value over the bundled
        # MobileNet IS its accuracy.
        cmd.append("--quantize_uint8=*")
    cmd += [saved_model_dir, tfjs_dir]
    print("==> " + " ".join(cmd))
    subprocess.check_call(cmd, env=converter_env(out_dir))
    return tfjs_dir


def report(tfjs_dir):
    model_json = os.path.join(tfjs_dir, "model.json")
    if not os.path.exists(model_json):
        fail("converter produced no model.json in " + tfjs_dir)
    with open(model_json, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

    shards = []
    for group in manifest.get("weightsManifest", []):
        shards.extend(group.get("paths", []))

    total = 0
    print("\n==> output in %s" % tfjs_dir)
    print("    model.json  %8.1f KB   (bundle this in models/vit384/)"
          % (os.path.getsize(model_json) / 1024.0))
    for shard in shards:
        size = os.path.getsize(os.path.join(tfjs_dir, shard))
        total += size
        print("    %-22s %8.1f KB   (publish, do NOT bundle)"
              % (shard, size / 1024.0))
    print("    %d shard(s), %.1f MB total weights" % (len(shards), total / 1048576.0))
    print("\nNext: copy model.json into models/vit384/, publish the shards, and")
    print("bump VIT384_WEIGHTS_VERSION in shared/ai-image-models.js.")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-dir", default="build/vit384",
                        help="scratch + output directory (default: build/vit384)")
    parser.add_argument("--quantize", action="store_true",
                        help="uint8-quantize the weights (~22 MB -> ~5.6 MB, "
                             "costs accuracy — measure first)")
    parser.add_argument("--skip-onnx", action="store_true",
                        help="reuse an existing model.onnx in --out-dir")
    parser.add_argument("--stage", choices=["export", "tfjs", "all"], default="all",
                        help="'export' = timm -> ONNX -> SavedModel; "
                             "'tfjs' = SavedModel -> TFJS. Run them in separate "
                             "venvs (see above); 'all' only works if one env "
                             "somehow satisfies both.")
    args = parser.parse_args()

    check_python()
    disable_onednn()
    os.makedirs(args.out_dir, exist_ok=True)
    saved_model_dir = os.path.join(args.out_dir, "saved_model")

    if args.stage in ("export", "all"):
        onnx_path = os.path.join(args.out_dir, "model.onnx")
        if not (args.skip_onnx and os.path.exists(onnx_path)):
            onnx_path = export_onnx(args.out_dir)
        saved_model_dir = onnx_to_saved_model(onnx_path, args.out_dir)
        print("")
        print("==> stage 'export' done: %s" % saved_model_dir)
        if args.stage == "export":
            print("Now run --stage tfjs in the tensorflowjs venv.")
            return

    if not os.path.isdir(saved_model_dir):
        fail("no SavedModel at %s — run --stage export first" % saved_model_dir)
    tfjs_dir = saved_model_to_tfjs(saved_model_dir, args.out_dir, args.quantize)
    report(tfjs_dir)


if __name__ == "__main__":
    main()
