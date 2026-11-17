// Stand-in for node-appwrite in tests of the Appwrite functions: an in-memory
// database that counts reads the way Appwrite bills them (one per document a
// list returns, one for an empty list, one per getDocument) and writes (one per
// create or update).
const state = {
  collections: new Map(), // collection id -> Map(document id -> document)
  reads: 0,
  writes: 0,
};

function collection(id) {
  if (!state.collections.has(id)) state.collections.set(id, new Map());
  return state.collections.get(id);
}

function notFound() {
  const e = new Error('Document with the requested ID could not be found.');
  e.code = 404;
  return e;
}

const Query = {
  equal: (attribute, value) => ({ method: 'equal', attribute, value }),
  greaterThanEqual: (attribute, value) => ({ method: 'greaterThanEqual', attribute, value }),
  orderDesc: (attribute) => ({ method: 'orderDesc', attribute }),
  limit: (value) => ({ method: 'limit', value }),
  offset: (value) => ({ method: 'offset', value }),
};

class Client {
  setEndpoint() { return this; }
  setProject() { return this; }
  setKey() { return this; }
}

class Databases {
  async listDocuments(databaseId, collectionId, queries = []) {
    let docs = [...collection(collectionId).values()];
    let limit = 25;
    let offset = 0;
    for (const q of queries) {
      if (q.method === 'equal') docs = docs.filter((d) => d[q.attribute] === q.value);
      if (q.method === 'greaterThanEqual') docs = docs.filter((d) => d[q.attribute] >= q.value);
      if (q.method === 'orderDesc') docs.sort((a, b) => (a[q.attribute] < b[q.attribute] ? 1 : -1));
      if (q.method === 'limit') limit = q.value;
      if (q.method === 'offset') offset = q.value;
    }
    const documents = docs.slice(offset, offset + limit).map((d) => structuredClone(d));
    state.reads += Math.max(1, documents.length);
    return { total: docs.length, documents };
  }

  async getDocument(databaseId, collectionId, id) {
    state.reads += 1;
    const doc = collection(collectionId).get(id);
    if (!doc) throw notFound();
    return structuredClone(doc);
  }

  async updateDocument(databaseId, collectionId, id, data) {
    const doc = collection(collectionId).get(id);
    if (!doc) throw notFound();
    state.writes += 1;
    Object.assign(doc, data, { $updatedAt: new Date(Date.now()).toISOString() });
    return structuredClone(doc);
  }

  async createDocument(databaseId, collectionId, id, data) {
    state.writes += 1;
    const docId = id === 'unique()' ? `doc${collection(collectionId).size + 1}` : id;
    const at = new Date(Date.now()).toISOString();
    const doc = { $id: docId, $createdAt: at, $updatedAt: at, ...data };
    collection(collectionId).set(docId, doc);
    return structuredClone(doc);
  }
}

const ID = { unique: () => 'unique()' };

module.exports = { Client, Databases, Query, ID, state };
