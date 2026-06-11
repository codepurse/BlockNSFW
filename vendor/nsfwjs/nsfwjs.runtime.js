(function (global) {
  'use strict';

  const tf = global.tf;
  const NSFW_CLASSES = {
    0: 'Drawing',
    1: 'Hentai',
    2: 'Neutral',
    3: 'Porn',
    4: 'Sexy'
  };
  const IMAGE_SIZE = 224;

  async function fetchArrayBufferWithFallback(resourceUrl) {
    try {
      const response = await fetch(resourceUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.arrayBuffer();
    } catch (originalError) {
      if (String(resourceUrl).endsWith('.bin')) {
        throw originalError;
      }

      const fallbackUrl = `${resourceUrl}.bin`;
      const fallbackResponse = await fetch(fallbackUrl);
      if (!fallbackResponse.ok) {
        throw originalError;
      }
      return await fallbackResponse.arrayBuffer();
    }
  }

  async function loadModelArtifacts(modelUrl) {
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch model.json (HTTP ${response.status})`);
    }

    const modelJson = await response.json();
    const modelArtifacts = {
      modelTopology: modelJson.modelTopology,
      format: modelJson.format,
      generatedBy: modelJson.generatedBy,
      convertedBy: modelJson.convertedBy,
    };

    if (Array.isArray(modelJson.weightsManifest) && modelJson.weightsManifest.length > 0) {
      const weightSpecs = [];
      const weightData = [];

      for (const group of modelJson.weightsManifest) {
        if (Array.isArray(group.paths)) {
          for (const relativePath of group.paths) {
            const absoluteUrl = new URL(relativePath, modelUrl).href;
            const buffer = await fetchArrayBufferWithFallback(absoluteUrl);
            weightData.push(new Uint8Array(buffer));
          }
        }
        if (Array.isArray(group.weights)) {
          weightSpecs.push(...group.weights);
        }
      }

      const weightDataConcat = new Uint8Array(weightData.reduce((sum, bytes) => sum + bytes.length, 0));
      let offset = 0;
      for (const bytes of weightData) {
        weightDataConcat.set(bytes, offset);
        offset += bytes.byteLength;
      }

      modelArtifacts.weightSpecs = weightSpecs;
      modelArtifacts.weightData = weightDataConcat.buffer;
    }

    if (modelJson.trainingConfig != null) {
      modelArtifacts.trainingConfig = modelJson.trainingConfig;
    }
    if (modelJson.userDefinedMetadata != null) {
      modelArtifacts.userDefinedMetadata = modelJson.userDefinedMetadata;
    }

    return modelArtifacts;
  }

  function getTopKClasses(values, topK) {
    const valuesAndIndices = [];
    for (let i = 0; i < values.length; i++) {
      valuesAndIndices.push({ value: values[i], index: i });
    }
    valuesAndIndices.sort((a, b) => b.value - a.value);

    const topClassesAndProbs = [];
    const count = Math.min(topK, valuesAndIndices.length);
    for (let i = 0; i < count; i++) {
      topClassesAndProbs.push({
        className: NSFW_CLASSES[valuesAndIndices[i].index],
        probability: valuesAndIndices[i].value
      });
    }
    return topClassesAndProbs;
  }

  class NSFWJSModel {
    constructor(modelUrl, options) {
      this.options = { size: IMAGE_SIZE, ...(options || {}) };
      this.intermediateModels = {};
      this.normalizationOffset = tf.scalar(255);
      this.model = null;
      this.endpoints = [];
      this.urlOrIOHandler = typeof modelUrl === 'string' && !modelUrl.endsWith('model.json')
        ? `${modelUrl}model.json`
        : modelUrl;
    }

    async load() {
      const ioHandler = typeof this.urlOrIOHandler === 'string'
        ? { load: () => loadModelArtifacts(this.urlOrIOHandler) }
        : this.urlOrIOHandler;
      this.model = await tf.loadLayersModel(ioHandler);
      this.endpoints = Array.isArray(this.model.layers)
        ? this.model.layers.map((layer) => layer.name)
        : [];

      const size = this.options.size || IMAGE_SIZE;
      const result = tf.tidy(() => this.model.predict(tf.zeros([1, size, size, 3])));
      try {
        if (result && typeof result.data === 'function') {
          await result.data();
        }
      } finally {
        if (result && typeof result.dispose === 'function') {
          result.dispose();
        }
      }
      return this;
    }

    infer(img, endpoint) {
      return tf.tidy(() => {
        if (endpoint != null && this.endpoints.indexOf(endpoint) === -1) {
          throw new Error(`Unknown endpoint ${endpoint}.`);
        }

        const imageTensor = img instanceof tf.Tensor ? img : tf.browser.fromPixels(img);
        const size = this.options.size || IMAGE_SIZE;
        const normalized = imageTensor.toFloat().div(this.normalizationOffset);
        const resized = (imageTensor.shape[0] !== size || imageTensor.shape[1] !== size)
          ? tf.image.resizeBilinear(normalized, [size, size], true)
          : normalized;
        const batched = resized.reshape([1, size, size, 3]);

        let model = this.model;
        if (endpoint != null) {
          if (!this.intermediateModels[endpoint]) {
            const layer = this.model.layers.find((candidate) => candidate.name === endpoint);
            this.intermediateModels[endpoint] = tf.model({
              inputs: this.model.inputs,
              outputs: layer.output
            });
          }
          model = this.intermediateModels[endpoint];
        }

        return model.predict(batched);
      });
    }

    async classify(img, topK = 5) {
      const logits = this.infer(img);
      try {
        const values = await logits.data();
        return getTopKClasses(values, topK);
      } finally {
        if (logits && typeof logits.dispose === 'function') {
          logits.dispose();
        }
      }
    }
  }

  async function load(modelUrl, options) {
    if (!tf) {
      throw new Error('TensorFlow runtime unavailable');
    }
    const model = new NSFWJSModel(modelUrl, options);
    await model.load();
    return model;
  }

  global.nsfwjs = {
    load,
    NSFWJSModel
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
