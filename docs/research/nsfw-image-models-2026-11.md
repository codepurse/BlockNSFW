# NSFW image models: research and local benchmark

Date: 2026-11-08 · Extension version measured: 2.0.5 (`dist/chrome`) · Machine: Intel Core Ultra 5 125H, Intel Arc iGPU, 16 GB

This report answers one question: is there an image model that would make BlockNSFW's AI Image Blocker more reliable (catch more, wrongly blur less) while staying small, private and fully offline? It combines a survey of what exists, the independent evidence about those models, and a local benchmark on this machine.

---

## Bottom line

1. **Our opt-in ViT-384 model should be pulled or relabelled now.** Through the real extension, at Balanced, it blurred **131 of 200 (65.5%) ordinary anime images**. I checked a random 24 of those by eye: all 24 are fully clothed characters. On photos it is no better than NSFW.js (3.9% vs 4.4% of safe photos wrongly blurred). The picker currently tells users it is "more accurate, and far less likely to flag ordinary photos". That has been shipping since 1.8.0.
2. **NSFW.js (our default) is better than its reputation, but weak on the content that matters most to us.** It never blurred a safe anime image, and it wrongly blurred 4.4% of safe photos (mostly tennis players and beds). But it caught only 2 of the 9 genuinely suggestive photos (lingerie and glamour shots) in the set. Its upstream is frozen: no retraining is planned.
3. **None of the popular Hugging Face ViTs is a clear upgrade.** Falconsai has the lowest false-positive rate of anything tested (0.4%), but an independent study found it misses about 60% of explicit images. AdamCodd, LukeJacob2023 and the SigLIP2 model wrongly blur about as many safe photos as NSFW.js or more, at 30–140× the size.
4. **The best candidate is Wingman Jr.'s N017** (MobileNetV4, Apache-2.0, already a TensorFlow.js graph model, maintained in October 2026). At its own "trusted" setting it wrongly blurred **0.7%** of safe photos and **0%** of anime, while catching **5 of 9** suggestive photos. That beats NSFW.js at Balanced on both sides. It costs 39.5 MB instead of 2.6 MB.
5. **Freepik's EVA-02 model has the best independent accuracy numbers**, but it is 86M parameters at 448 px. That is far too heavy to run on every image of a page. Use it as a reference or teacher, not as the runtime model.
6. **What this benchmark cannot tell you:** how much real pornography each model misses. No explicit images were downloaded, so recall comes only from published independent studies. A recall test is the one thing that should happen before any model swap ships. See *Next steps*.

**Production pick:** N017, introduced behind a recall test, with NSFW.js kept bundled as the offline fallback.

---

## 1. What we run today

| | NSFW.js MobileNetV2 (default) | Marqo ViT-384 (opt-in, "ViT-384") |
|---|---|---|
| Source | GantMan/nsfw_model → infinitered/nsfwjs, MIT | Marqo/nsfw-image-detection-384, Apache-2.0 |
| Architecture | MobileNetV2, 224 px, 5 classes (Porn, Hentai, Sexy, Drawing, Neutral) | ViT-tiny/16, 384 px, binary NSFW/SFW, 5.6M params |
| Size | 2.6 MB, bundled | 22.4 MB, fetched from GitHub on first use |
| Runtime | TF.js 4.22 layers model via `nsfwjs.runtime.js`, WebGL in the offscreen document (Chrome) or event page (Firefox) | TF.js 4.22 graph model via `tf.loadGraphModel` |
| Balanced rule | Porn+Hentai ≥ 0.60, or Sexy ≥ 0.90 | NSFW ≥ 0.30 |
| Upstream state | nsfwjs v4.4.0 (2026-08-04) is packaging only; maintainer: "not currently retraining… on a freeze" (#893, 2025-01) | Weights last changed 2024-11-27; no maintainer replies since 2025-01; data-provenance question open (discussion #6, 2026-10-27) |

Both models share `shared/ai-image-models.js`, `offscreen.js` and the service-worker fallback in `background.js`.

---

## 2. How I tested, and what that can't tell you

**Test set: 1,217 safe-for-work images**, chosen to be hard for NSFW filters:

| Slice | Count | Source |
|---|---|---|
| Swimwear / beach | 223 | COCO val+train 2017, caption keywords (bikini, swimsuit, shirtless…) |
| Beds, baths, couples | 215 | COCO (bed, shower, towel, kissing, underwear…) |
| Sport / fitness | 120 | COCO (tennis, yoga, gym…) |
| Babies and children | 100 | COCO |
| Person close-ups | 180 | COCO, largest person box > 30% of the frame |
| No people (control) | 100 | COCO |
| Anime, general | 200 | Safebooru, `rating:general` (girls, boys, groups, scenery) |
| Anime, swimsuits | 79 | Safebooru, `rating:general swimsuit` (reported separately) |

**Every image any model flagged was reviewed by eye** (339 images) and given one of three labels:
- **S, safe:** ordinary clothing, children, sport, anime characters. Blurring these is a plain error.
- **B, revealing:** swimwear, shirtless men, underwear in a plain context. Whether to blur these is a product choice (Strict might; Balanced probably shouldn't).
- **X, sexualised:** lingerie and boudoir posing, glamour bikini shoots, body-paint nudity. COCO turned out to contain 9 of these. Blurring them is correct for this product.

That gives **801 safe photos, 128 revealing photos, 9 sexualised photos and 200 safe anime images**.

**Rules were fixed in advance**, from each model's own documentation or our shipped presets, not tuned on this data. NSFW.js and ViT-384 were measured through the **real extension** (headless Chrome, service worker → offscreen document → TF.js WebGL on the Arc GPU). Everything else ran in Python (PyTorch / ONNX Runtime, CPU), using each model's official preprocessing. The ONNX copy of NSFW.js agreed with the extension to within a point.

**Limits:**
- **No recall.** No explicit images were downloaded, so this measures only one side: wrongly blurred safe images. The 9 sexualised photos are a hint at sensitivity to suggestive content, not a recall figure. For explicit recall, see section 4.
- One machine. CPU timings are batch-1 and approximate; several ran while other jobs shared the CPU.
- COCO and Safebooru are not the open web. Real browsing has more ads, thumbnails, text-heavy images and memes.

---

## 3. Local results

### 3.1 False positives after hand review

"Wrongly blurred" counts only images labelled S. Percentages are of 801 safe photos and 200 safe anime images. The default setting for each model is marked ★.

| Model (how it ran) | Setting | Safe photos wrongly blurred (of 801) | Safe anime wrongly blurred (of 200) | Revealing photos blurred (of 128) | Sexualised photos blurred (of 9) |
|---|---|---|---|---|---|
| **NSFW.js MobileNetV2** (current default, in the extension) | Relaxed | 11 (1.4%) | 0 | 12 | 0 |
| | **Balanced ★** | **35 (4.4%)** | **0** | 27 | **2** |
| | Strict † | 77 (9.6%) | 1 (0.5%) | 47 | 3 |
| **Marqo ViT-384** (current opt-in, in the extension) | Relaxed | 12 (1.5%) | 114 (57.0%) | 15 | 4 |
| | **Balanced ★** | **31 (3.9%)** | **131 (65.5%)** | 27 | **7** |
| | Strict | 61 (7.6%) | 146 (73.0%) | 44 | 9 |
| **Wingman N017** | trusted, 0.950 (their FPR 0.4% point) | **6 (0.7%)** | **0** | 40 | **5** |
| | 0.931 (their FPR 0.6% point) | 10 (1.2%) | 0 | 43 | 6 |
| | neutral, 0.834 ★ (their FPR 1.5% point) | 21 (2.6%) | 4 (2.0%) | 64 | 8 |
| | untrusted, 0.265 † (their FPR 10% point) | 154 (19.2%) | 37 (18.5%) | 102 | 9 |
| Falconsai | P(nsfw) ≥ 0.5 ★ | 3 (0.4%) | 5 (2.5%) | 2 | 2 |
| AdamCodd | P(nsfw) ≥ 0.8 | 12 (1.5%) | 1 (0.5%) | 46 | 6 |
| | P(nsfw) ≥ 0.5 ★ | 32 (4.0%) | 3 (1.5%) | 67 | 8 |
| Freepik (EVA-02) | not measured: the CPU run was stopped after more than 75 minutes without finishing; see section 4 for its independent results | — | — | — | — |
| NudeNet 320n | exposed genitals/anus ≥ 0.4 or exposed female breast ≥ 0.5 ★ | 6 (0.7%) | 0 | 7 | 0 |
| SigLIP2 x256 (prithivMLmods) | Balanced-style rule ★ | 46 (5.7%) | 5 (2.5%) | 28 | 2 |
| NSFW.js InceptionV3 | Balanced ★ | 46 (5.7%) | 2 (1.0%) | 34 | 4 |
| LukeJacob2023 | Balanced-style rule ★ | 69 (8.6%) | 5 (2.5%) | 85 | 8 |
| deepghs anime_rating (anime-only model) | r15 + r18 ≥ 0.5 ★ † | 226 (28.2%) | 19 (9.5%) | 102 | 8 |

★ the model's documented default, or our shipped preset. "Balanced-style rule" applies our NSFW.js Balanced rule to that model's matching classes.
† includes flagged images that were not individually reviewed. They are counted as safe, so the first column is an upper bound.

ViT-384's anime flags were not reviewed one by one. A random sample of 24 of them was: all 24 are ordinary, clothed characters.

### 3.2 What the numbers say

- **ViT-384 treats drawn people as NSFW.** It is fine on anime scenery: 0 of 30 landscapes. But in the extension it flagged 101 of 123 images with girls and 35 of 53 with boys, all rated "general" on Safebooru. Even at Relaxed it blurs 57% of safe anime. It also wrongly blurred 7 of the 100 baby and child photos, the most of any model. Where it *is* strong is the sexualised photos (7 of 9 at Balanced). That's why the 18-photo calibration last September looked good: it contained no drawings.
- **NSFW.js's mistakes are mostly sport and beds.** Of its 35 wrongly blurred safe photos, 15 are sport (tennis players mid-serve) and 11 are beds or bathrooms. Its "Drawing" class keeps it at 0% on anime. Its weakness runs the other way: it let 7 of 9 sexualised photos through at Balanced.
- **N017 is better at both ends.** Compared with NSFW.js Balanced, N017 at "trusted" wrongly blurred 6 safe photos instead of 35, no anime, and caught 5 sexualised photos instead of 2. Even at "neutral" (2.6%) it is below NSFW.js's error rate while catching 8 of 9. What you pay is revealing content: it blurs 40–64 of the 128 swimwear and shirtless photos, against NSFW.js's 27. For a recovery-focused product that is arguably the right lean, but it should be a conscious choice.
- **Its 10%-FPR point is not usable on the web.** At 0.265 it wrongly blurred 19% of safe photos and anime. Use the low-FPR points.
- **Bigger is not better here.** The ViT-B models (Falconsai, AdamCodd, LukeJacob2023, SigLIP2) are 30–140× NSFW.js's size. None beat it at a comparable sensitivity. Falconsai's 0.4% comes from barely flagging anything short of explicit (2 of 128 revealing, 2 of 9 sexualised). That matches its independent recall of 40.7%.
- **NSFW.js's larger InceptionV3 model is worse than the MobileNetV2 we ship** (5.7% vs 4.4%). So there's no point in the "upgrade to the bigger NSFW.js model" path that was once blocked by the layers-only runtime.
- **NudeNet** wrongly blurred few safe photos (0.7%) and no anime, but it also caught none of the 9 sexualised photos. It only fires on exposed anatomy. Its licence rules it out regardless.

### 3.3 Speed and size

| Model | Weights | CPU, ms per image (batch 1, approx.) | In the extension (Arc iGPU, WebGL) |
|---|---|---|---|
| NSFW.js MobileNetV2 | 2.6 MB | 5 (ONNX copy) | 62 ms end-to-end per image (fetch + decode + inference + messaging); 35 ms/image in batches of 4 |
| NudeNet 320n | 12 MB | 30 | — |
| **Wingman N017** | 39.5 MB | 39 | 64 ms end-to-end per image; 30 ms/image in batches of 4 (measured after integration) |
| NSFW.js InceptionV3 | 89 MB | 56 | — |
| Marqo ViT-384 | 22.4 MB | 73 | 186 ms end-to-end per image; 103 ms/image in batches of 4 |
| Falconsai / LukeJacob2023 (ViT-B 224) | 343 MB (87 MB int8) | ~210 | — |
| SigLIP2 x256 | 372 MB | 323 | — |
| AdamCodd (ViT-B 384) | 344 MB (88 MB int8) | 685 | — |
| Freepik (EVA-02 448) | 173 MB bf16 / 345 MB fp32 | ~3,000+ (could not finish 1,217 images in 75 minutes) | — |

CPU figures come from PyTorch or ONNX Runtime on all 14 threads, and some ran while other jobs shared the CPU. Read them as an ordering, not exact costs. The in-extension figures are the production path through the service worker and offscreen document.

---

## 4. Independent evidence

Model authors' own numbers are almost all measured on their own held-out split, which is weak evidence. These are the only third-party comparisons found.

**UnsafeBench** (Qu et al., arXiv 2405.03486, CCS): 10,146 labelled images, real (LAION-5B) and AI-generated (Lexica). F1 on the *Sexual* category:

| Classifier | Real images | AI-generated |
|---|---|---|
| GPT-4V | 0.866 | 0.827 |
| SD safety checker (CLIP ViT-L/14) | 0.833 | 0.727 |
| InstructBLIP | 0.796 | 0.757 |
| LAION CLIP NSFW detector | 0.783 | 0.678 |
| Multi-headed safety classifier | 0.692 | 0.815 |
| NudeNet | 0.650 | 0.596 |

Robustness: NudeNet was the classifier most vulnerable to small adversarial perturbations. All classifiers failed more on artistic-style nudity and on grid layouts.

**KidsNanny** (arXiv 2603.16181, March 2026; the authors sell a competing product): UnsafeBench *Sexual* subset, 1,054 images, one shared threshold.

| Model | F1 | Precision | Recall |
|---|---|---|---|
| Freepik/nsfw_image_detector | **81.1** | 86.8 | **76.1** |
| NudeNet | 76.0 | 74.0 | 78.2 |
| AdamCodd/vit-base-nsfw-detector | 73.9 | 81.2 | 67.8 |
| Falconsai/nsfw_image_detection | 56.3 | 91.2 | **40.7** |

**route96 model card** (6,592 images from public datasets; the author's own model is in the table, so it is not neutral): Falconsai precision .922 / recall .905; AdamCodd .834 / .954 with 681 false positives on about 3,000 safe images; LukeJacob2023 .827 / .923.

**Bias and failure modes:**
- *Leu et al., FAccT 2024* audited GantMan's InceptionV3 (the NSFW.js family) on 22k ordinary photos. Overall false-positive rate was 0.4–0.6%, but women were flagged about 5× as often as men (1.25% vs 0.21%), and children most of all (1.07%), mostly babies in nappies. The LAION CLIP classifier flagged 18.5% of women.
- *Riccio et al., 2024* on artwork nudes: NudeNet flagged 34.7% of censored art, OpenNSFW2 47.9%, Bumble Private Detector 21.5%.
- nsfwjs issue #918: AI-generated porn reads as "Sexy", not "Porn".
- *Stealthy Porn (IEEE S&P 2019)*: grayscale, blur and texture overlays let 35.6% of promotional porn past every commercial detector tested.
- GantMan #105: whole-page screenshots squeezed to 224 px lose the content entirely.

**Not independently evaluated anywhere:** Marqo ViT-384, Wingman N017, viddexa nano, NSFW.js MobileNetV2 itself.

---

## 5. Candidate catalogue

Licences were read on the model card and, where it matters, checked against the base model and the training framework. "Paid OK" means usable inside BlockNSFW with its paid Supporter tier.

### 5.1 Whole-image classifiers (the drop-in family)

| Model | Architecture, input | Size | Labels | Licence, paid OK? | Evidence | Verdict |
|---|---|---|---|---|---|---|
| **NSFW.js MobileNetV2** (current) | MobileNetV2, 224 | 2.6 MB | 5 classes | MIT, yes | Own data ~90%; FAccT audit of sibling | Keep as fallback |
| NSFW.js InceptionV3 | InceptionV3, 299 | 89 MB | 5 classes | MIT, yes | Own ~93% | **Worse** than MobileNetV2 locally (5.7% FP). Don't upgrade to it |
| **Wingman Jr. N017** ([repo](https://github.com/wingman-jr-addon/model/tree/master/N017)) | MobileNetV4 Hybrid-M, 224, grey-padded | 39.5 MB (TF.js graph + ONNX) | unsafe score + S/Q/R/X | Apache-2.0 weights, yes | Own 84,744 images: AUC 0.983; 77% caught at 0.4% FPR | **Top candidate** |
| Wingman SQRXR 112 | EfficientNet-Lite0, 224 | 14.4 MB TF.js | S/Q/R/X | CC0, yes | Superseded by N017 (own data) | Smaller fallback option; not tested |
| Marqo ViT-384 (current opt-in) | ViT-tiny, 384 | 22.4 MB | binary | Apache-2.0, yes (provenance question open) | Own 98.56%; none independent | **Pull or relabel**: blurs anime |
| Falconsai/nsfw_image_detection | ViT-B/16, 224 | 343 MB (int8 87 MB) | binary | Apache-2.0, yes | Independent recall 40.7% | Explicit-only; too lenient for us |
| AdamCodd/vit-base-nsfw-detector | ViT-B/16, 384 | 344 MB (int8 88 MB) | binary, "restrictive" | Apache-2.0, yes | Independent F1 73.9 | Blurs most swimwear; no gain |
| **Freepik/nsfw_image_detector** | EVA-02 base, 448 | 173 MB bf16 (345 MB fp32) | neutral/low/medium/high | MIT, yes | **Best independent F1 (81.1)** | Reference and teacher, not runtime |
| LukeJacob2023/nsfw-image-detector | ViT-B, 224 | 343 MB | 5 classes | Apache-2.0, yes | route96 precision .827 | Worst on photos locally (8.6%) |
| prithivMLmods/siglip2-x256-explicit-content (= strangerguardhf) | SigLIP2-base, 256 | 372 MB | 5 classes | Apache-2.0, yes | Own 91.4% | No gain (5.7% FP) |
| viddexa/nsfw-detection-2-nano | EfficientNet-B0, 224 | 16 MB | 5 classes (NSFW.js scheme) | Apache-2.0 tag; trained on LSPD (research-only access) | LSPD test macro-F1 93.0 | Most direct small replacement; **not tested** (offline-only decision); check data licence |
| taufiqdp/mobilenetv4_conv_small…nsfw | MobileNetV4-S, 224 | 10 MB | 5 classes | Apache-2.0 tag | Empty card | Not tested; no evidence |
| bhky/opennsfw2 (Yahoo open_nsfw port) | ResNet-50-thin, 224 | 24 MB | porn score | MIT / BSD-2, yes | Art: flags 36–48% of nudes; no drawings | Dated |
| bumble-tech/private-detector | EfficientNetV2-M, 480 | ~600 MB zip | lewd score | Apache-2.0, yes | Users report many false positives (cats) | Too big, no gain |
| NsfwSpy.js | MobileNetV2, TF.js graph | 24 MB | 4 classes | MIT, yes | Own data | Not better than NSFW.js per its own issues |
| giacomoarienti/nsfw-classifier | ViT-B, 224 | 343 MB | 5 classes | **CC-BY-NC-ND: no** | — | Excluded |
| TostAI / MichalMlodawski FocalNet "large" | FocalNet-base, 512 | 349 MB | safe/questionable/unsafe | **CC-BY-NC-SA: no** (an "Apache" re-upload by lovetillion is the same bytes relabelled) | — | Excluded |
| prithivMLmods/Nsfw_Image_Detection_OSS | MetaCLIP-2 S16 | 87 MB | binary | **CC-BY-NC: no** | — | Excluded |

### 5.2 Object detectors (find exposed body parts)

| Model | Size | Licence, paid OK? | Notes |
|---|---|---|---|
| NudeNet v3.4 320n / 640m | 12 MB / 104 MB ONNX | **AGPL-3.0** per the maintainer (YOLOv8); PyPI still says MIT. **No** for us | Lowest false positives locally (0.7%), and its covered/exposed split spares swimwear. But independent F1 is only 0.62–0.76; it is weak on drawings (0.44 accuracy on art) and adversarially fragile; training data is undocumented, with open provenance concerns; maintainer is looking for new maintainers |
| EraX-NSFW (YOLO11) | 5–41 MB | Card says Apache-2.0, but Ultralytics claims AGPL for all YOLO-trained models: **treat as no** | Unfinished card; one user measured 75% detection |
| deepghs anime_censor_detection | 12–45 MB | MIT label, same Ultralytics problem | Anime only |

No licence-clean (non-YOLO) nudity detector exists ready-made.

### 5.3 CLIP and embedding classifiers

| Model | Size | Licence | Notes |
|---|---|---|---|
| LAION CLIP-based NSFW Detector | CLIP ViT-L/14 (~900 MB) + tiny head; a ViT-B/32 head also exists | MIT, yes | Independent F1 0.78 (real) / 0.68 (AI); unmaintained since 2023; flagged 18.5% of ordinary photos of women in the FAccT audit |
| SD safety checker | 1.2 GB | No licence stated | Best conventional classifier in UnsafeBench (0.83), but huge and easy to bypass |
| Q16, Multi-headed SC | CLIP ViT-L/14 | Unclear / none | Not nudity-specific, or trained on 800 images |
| Apple MobileCLIP / MobileCLIP2 | 12–37 MB int8 vision encoder | **Research-only since 2025-08-29**: no | Would have been the best size fit |
| SigLIP / SigLIP2 base, OpenCLIP B/32, TinyCLIP | 55–94 MB quantised | Apache / MIT, yes | No published NSFW accuracy; only useful with a head we would train ourselves |

### 5.4 Vision-language guard models

LlavaGuard 1.2 (0.5B–7B), ShieldGemma 2 (4B), Llama Guard 3 Vision / 4 (11–12B), SingGuard-2B, Nemotron 3.5 Content Safety (4B). The smallest is about 0.9B parameters (≈ 0.5 GB even at 4-bit), with a ~400M-parameter vision tower and autoregressive decoding. That rules out running one per image in a browser or on a phone. Licences also carry strings: Gemma treats distillation as a derivative, Llama excludes EU licensees for multimodal models, and Qwen's research licence forbids paid use. They are useful only as offline labellers. SingGuard-2B (Apache-2.0) is the cleanest for that.

### 5.5 Anime-specific

deepghs `anime_rating` / `anime_dbrating` MobileNetV3 models (16.8 MB, MIT / OpenRAIL) and SmilingWolf WD taggers (378 MB+, Apache-2.0). They are trained on anime only. Locally, the deepghs rating model flagged up to 28% of safe *photos*, so it could only ever run behind an anime-vs-photo router. Given that NSFW.js and N017 already make few anime mistakes, this isn't worth the complexity now.

---

## 6. Integration

**Runtimes, late 2026:**

| Runtime | State | Fit for us |
|---|---|---|
| TensorFlow.js 4.22 (current) | Last stable release 2024-10-21; only one commit since mid-2025. Dormant, not deprecated | Still works everywhere on WebGL. N017 ships as a TF.js graph model, and our vendored `tf.es2017.js` already exports `loadGraphModel`, which is how ViT-384 loads. Not verified locally for N017; see below |
| ONNX Runtime Web 1.31.1 | Monthly releases. WASM everywhere; WebGPU on Chrome/Edge (Firefox 141+ on Windows); WebGL in maintenance | Wasm adds 2.8 MB brotli (14 MB raw); the WebGPU build ~6 MB brotli. Our CSP already allows `'wasm-unsafe-eval'`. **Firefox extension pages are not cross-origin isolated, so WASM there is single-threaded** |
| Transformers.js v4 | Active (4.3.2, 2026-10-28) | Convenient for HF ViTs, but pins a dev ORT build and defaults to a CDN for wasm (must be overridden for store review) |
| LiteRT.js 2.6 | Announced July 2026 | Promising (Google positions it as TF.js's successor), but no documented extension or Firefox support yet |
| Android | ONNX Runtime Android 1.31.1; LiteRT 2.3.2; NNAPI deprecated in Android 15 | One ONNX file could serve both the extension and the Android app |

**Per-candidate effort:**
- **N017: low.** A TF.js graph model like ViT-384, so it reuses `shared/vit-classifier.js`'s loader, shard caching and fallback. It needs its own preprocessing (pad to square with grey 128, ImageNet mean/std, NHWC) and two outputs (`unsafe_score`, `sqrx_probabilities`), a new score shape in `verdictFor()`, and new threshold presets. Its published operating points map directly onto Relaxed / Balanced / Strict. Ship it fetched-on-demand (like ViT-384), or try TF.js uint8 weight quantisation (~10 MB) and measure the accuracy cost. **Verified after integration:** inside the real extension it loads and runs on our TF.js 4.22 (WebGL, Arc iGPU). Its scores match the ONNX reference: median difference 0.005 in the unsafe score. Only 9 of 1,217 images land on the other side of the Balanced bar, all borderline images where browser and Python resizing differ.
- **Freepik: high.** No official ONNX (pull request #4 open); EVA-02 at 448 px means 1,024 tokens per image. Only realistic as an offline tool.
- **viddexa nano: medium.** PyTorch only. Would need an ONNX → TF.js conversion like `tools/convert_vit384.py`, or a move to ONNX Runtime.
- **Any HF ViT-B: medium–high.** 87–88 MB even at int8. Browser runs reported at ~1.4 s per image on WASM and ~120 ms on WebGPU (Transformers.js benchmark, ViT-base-224). Too slow for pages with dozens of images.

---

## 7. Would combining models help?

Only the false-positive side can be measured here, and that is the side where combining helps least: AND-ing two models can only remove blurs, and recall can only drop.

| Combination | Safe photos wrongly blurred | Safe anime | Revealing blurred (of 128) | Sexualised blurred (of 9) |
|---|---|---|---|---|
| N017 neutral **and** NSFW.js Balanced | 1 (0.1%) | 0 | 15 | 2 |
| N017 trusted **or** NSFW.js Balanced | 41 (5.1%) | 0 | 56 | 5 |
| N017 trusted alone, for comparison | 6 (0.7%) | 0 | 40 | 5 |

- **"Both must agree" almost eliminates errors** (1 safe photo), but it inherits NSFW.js's blindness to suggestive content (2 of 9). It would also lose whatever explicit images either model misses alone.
- **"Either may block" with NSFW.js adds nothing.** It brings back NSFW.js's 35 errors without catching a single extra sexualised photo over N017 alone.
- **Verdict: no ensemble for now.** N017 alone beats every pairing with NSFW.js. The combination that already exists, the page-level fuse rule (hold a page only when 3+ images and 25%+ of those checked are blurred), stays the right place to absorb individual mistakes.
- **Where a second model could earn its cost later:** a cascade, where the cheap model screens and only uncertain scores go to a heavier model. That needs a heavier model worth calling, measured on a recall set. Nothing in the browser-sized tier qualifies yet.

---

## 8. Ranked recommendations

Ranked for BlockNSFW's actual job: blur porn and sexualised images on any web page, on ordinary laptops, offline, without blurring swimwear photos and anime.

**1. Wingman Jr. N017 — production candidate**
- *Why:*
  - Fewest wrongly blurred safe photos of any model that also catches suggestive content: 0.7% at "trusted".
  - No anime mistakes at "trusted".
  - Trained on images captured from real browsing sessions, which is our exact domain.
  - Publishes calibrated operating points (false-positive rate 0.4%, 1.5% and 10%) that map onto our three strictness levels.
- *Pros:*
  - Apache-2.0 weights, with an unusually complete provenance record.
  - Ships as a TF.js graph model *and* ONNX, so it fits today's runtime and a future ONNX Runtime one.
  - MobileNetV4 is a mobile-class architecture: 39 ms/image on this CPU, against 73 ms for ViT-384.
  - Separate S/Q/R/X levels.
  - Actively maintained (commits in October 2026), and in daily use inside a shipping Firefox blocker.
- *Cons:*
  - 39.5 MB, 15× NSFW.js. Fetch on demand like ViT-384, or test uint8 quantisation.
  - All accuracy numbers are on Wingman's own private data. No independent evaluation exists.
  - "Unsafe" also includes some gore/horror (R), which differs slightly from our scope.
  - At "neutral" it blurs half of revealing photos (64/128) and 2% of anime.
  - Explicit recall was not measured here.
- *Against NSFW.js:* better at both ends on our set. At "trusted": 0.7% vs 4.4% of safe photos, 0% vs 0% anime, 5/9 vs 2/9 suggestive.
- Repository: <https://github.com/wingman-jr-addon/model/tree/master/N017>

**2. NSFW.js MobileNetV2 — keep, as the bundled fallback**
- *Why:* 2.6 MB, offline on first run, about 20–30 ms on WebGL, and it never misread a safe anime image here.
- *Cons:*
  - Weak on sexualised-but-not-explicit photos (2/9).
  - Its "Sexy" class is what blurs swimwear (27/128) and sport.
  - Upstream training is frozen.
  - Independently known to over-flag women and babies (FAccT 2024 audit of its sibling model).
- Repository: <https://github.com/infinitered/nsfwjs> (MIT)

**3. Freepik/nsfw_image_detector — accuracy reference and teacher**
- *Why:* best independent numbers of any open model (F1 81.1, recall 76.1 on UnsafeBench's *Sexual* subset). Four levels (neutral/low/medium/high) separate suggestive from explicit. MIT.
- *Cons:*
  - EVA-02 base at 448 px: 86M parameters and about 3 s or more per image on this CPU. It could not finish the 1,217-image set in 75 minutes.
  - Not usable per image in a browser extension.
  - No official ONNX.
  - Training data is "synthetically labelled" from undisclosed sources.
- *Use:*
  - Label a recall test set.
  - Second-check calibration of N017's thresholds.
  - Possibly distil a small model later. MIT allows that; check the data terms first.
- Repository: <https://huggingface.co/Freepik/nsfw_image_detector>

**4. viddexa/nsfw-detection-2-nano — worth a look, untested here**
- *Why:* 16 MB EfficientNet-B0 with exactly NSFW.js's five classes, so it is the most direct small replacement. Its authors published a peer-reviewed comparison (Akyon & Temizel).
- *Cons:*
  - Metrics are on the LSPD test split, which is likely also its training distribution. LSPD is research-access only, so the commercial status of the derived weights is unclear despite the Apache-2.0 tag.
  - PyTorch only, so it needs conversion.
  - Low adoption.
- Repository: <https://huggingface.co/viddexa/nsfw-detection-2-nano>

**5. AdamCodd/vit-base-nsfw-detector — only if we wanted a "very strict" mode**
- *Why:* caught 8 of the 9 suggestive photos with a safe-photo error rate close to NSFW.js (4.0%), and only 1.5% anime.
- *Cons:*
  - Blurs over half of swimwear and shirtless photos (67/128) by design.
  - 88 MB even at int8, and 685 ms/image on CPU.
  - Independent recall only 67.8%.
- Apache-2.0.

**6. Falconsai/nsfw_image_detection — explicit-only, too lenient**
- Lowest false positives of any classifier here (0.4%). But it passes almost all revealing and suggestive content (2/128, 2/9), and independently misses about 60% of explicit images (recall 40.7%). 343 MB. Apache-2.0.

**7. NudeNet 320n — technically attractive, legally out**
- 12 MB, and the covered/exposed region labels are exactly what an explainable filter wants (0.7% false positives here). But the maintainer says it is AGPL-3.0 (YOLOv8). That is incompatible with our closed `extras-private` code. Its data provenance is also disputed, and it is weak on drawings.

**8. Marqo ViT-384 (our opt-in) — remove or relabel**
- Good at suggestive photos (7/9) and fine on ordinary photos (3.9%). But it treats drawn people as NSFW: 65.5% of safe anime blurred at Balanced, 57% even at Relaxed.

**Excluded:**
- *Licence:* giacomoarienti (NC-ND), the FocalNet "large" copies (NC-SA), prithivMLmods OSS (NC), MobileCLIP (research-only), EraX and the deepghs censor detector (Ultralytics AGPL).
- *Size:* LAION / SD safety checker / VLM guards are offline teachers at best.
- *Results here:* LukeJacob2023 (8.6% of safe photos), SigLIP2 x256 (5.7%), NSFW.js InceptionV3 (5.7%).

### Top 3 to test

1. **Wingman N017.** Integration spike inside the extension, then the recall test.
2. **Freepik.** As the reference: run it on the same recall set, so N017's results have something trustworthy to be compared against.
3. **viddexa nano.** Only after confirming the LSPD-derived licence situation with its authors. If it holds up, it is the size-preserving alternative (16 MB).

**Production choice: N017**, with NSFW.js kept in the package as the offline-first fallback. That way the first page load is still filtered while N017's weights download, and nothing breaks if the download fails. That is the same arrangement ViT-384 uses today.

---

## 9. Next steps

1. **Fix the ViT-384 option now** (small, no model work).
   - Either remove it from the picker, or relabel it ("experimental: blurs most anime and drawings") and change its blurb.
   - Its current claim, "far less likely to flag ordinary photos", isn't supported.
   - It was calibrated on 18 photos with no drawings, which is how this was missed.
   - Users who already chose it keep it until migrated. The verdict cache is already tagged per model, so switching is safe.
2. **N017 is now integrated as a downloadable option** (2026-11-08, uncommitted). The weights are in `data/models/n017/` and need pushing to `main` before downloads work. In Chrome it loads on our TF.js 4.22, matches the reference scores, and runs at about 64 ms per image. Still to check: Edge and Firefox, and uint8 weight quantisation.
3. **Pick thresholds from N017's published operating points, not from intuition.**
   - Our set shows the 10%-FPR "untrusted" point (0.265) is far too aggressive: it wrongly blurred 19% of safe photos.
   - A sensible starting map: Relaxed 0.950 (FPR 0.4%), Balanced 0.931 (FPR 0.6%), Strict 0.834 (FPR 1.5%).
   - Confirm it with the recall test.
4. **Recall test before shipping any swap.** This needs explicit images, so it is your call: how, where, and whether someone else should run it.
   - The least-effort option is UnsafeBench's labelled test split. It is on Hugging Face behind a data-use agreement that permits "responsible commercial use", and it includes AI-generated images.
   - Run it headless, never display the images, and delete them afterwards.
5. **Runtime: no migration needed for this.** N017 runs on the TF.js we already ship. TF.js is dormant, though, so the next model after N017 (and the Android app) should plan for ONNX Runtime. N017 also ships an ONNX file, so the choice doesn't lock us in.

---

## Appendix: reproducing this

Benchmark scripts are kept in `.verify/model-bench/` (git-ignored). The images, Python environment and model weights were in the session scratchpad and are not kept.

- `fetch_coco.py`, `fetch_coco_train.py`, `fetch_anime.py` build the test set.
- `score.py` runs each candidate model.
- `cdp-bench.js` runs the built extension's own classifier in headless Chrome.
- `analyze.py`, `sheets.py`, `adjudicate.py` produce the tables. Hand labels are in `labels.json`.

Key sources:
- UnsafeBench, arXiv 2405.03486
- KidsNanny, arXiv 2603.16181
- Leu et al., FAccT 2024
- Riccio et al., arXiv 2409.17156
- Akyon & Temizel, arXiv 2312.16338
- Wingman N017 README and `evaluation_summary.json`
- Freepik, Marqo, Falconsai, AdamCodd, viddexa model cards
- NudeNet issues #177, #162
- Apple ml-mobileclip commit e15d36e
- ONNX Runtime Web, Transformers.js and LiteRT.js release pages
