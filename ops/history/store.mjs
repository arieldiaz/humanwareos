// MongoDB is a rebuildable local index, never a system of record.
export const DEFAULT_URI = "mongodb://127.0.0.1:27017";
const DB = "humanware_history";

const metaText = (meta) => Object.values(meta ?? {}).filter((value) => value != null).flat().join(" ");

export async function openStore(uri = DEFAULT_URI) {
  const {MongoClient} = await import("mongodb");
  const client = new MongoClient(uri, {serverSelectionTimeoutMS: 3000});
  await client.connect();
  const records = client.db(DB).collection("records");
  await records.createIndex({title: "text", metaText: "text", localText: "text"}, {name: "history_text", weights: {title: 10, metaText: 5, localText: 1}, default_language: "english"});
  await records.createIndex({ts: -1});
  return {
    async upsert(docs, ingestedAt = new Date()) {
      if (!docs.length) return 0;
      const ops = docs.map((doc) => ({replaceOne: {filter: {_id: doc._id}, replacement: {...doc, metaText: metaText(doc.meta), ingestedAt}, upsert: true}}));
      const result = await records.bulkWrite(ops, {ordered: false});
      return result.upsertedCount + result.modifiedCount;
    },
    search(goal, limit = 200) {
      return records.find({$text: {$search: goal}}, {projection: {score: {$meta: "textScore"}}}).sort({score: {$meta: "textScore"}, ts: -1}).limit(limit).toArray();
    },
    show: (id) => records.findOne({_id: id}),
    count: () => records.countDocuments(),
    close: () => client.close(),
  };
}
