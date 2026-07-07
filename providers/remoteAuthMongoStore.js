const fs = require('fs');
const path = require('path');

class RemoteAuthMongoStore {
    constructor({ mongoose, dataPath = './.wwebjs_auth/' } = {}) {
        if (!mongoose) throw new Error('A valid Mongoose instance is required for RemoteAuthMongoStore.');
        this.mongoose = mongoose;
        this.dataPath = path.resolve(dataPath);
    }

    bucket(session) {
        return new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
            bucketName: `whatsapp-${session}`,
        });
    }

    archivePath(session) {
        return path.join(this.dataPath, `${session}.zip`);
    }

    async ensureDataPath() {
        await fs.promises.mkdir(this.dataPath, { recursive: true });
    }

    async sessionExists({ session }) {
        const collection = this.mongoose.connection.db.collection(`whatsapp-${session}.files`);
        return (await collection.countDocuments()) > 0;
    }

    async save({ session }) {
        await this.ensureDataPath();
        const archivePath = this.archivePath(session);
        try {
            await fs.promises.access(archivePath);
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }

        const bucket = this.bucket(session);
        await new Promise((resolve, reject) => {
            const read = fs.createReadStream(archivePath);
            const upload = bucket.openUploadStream(`${session}.zip`);

            read.once('error', reject);
            upload.once('error', reject);
            upload.once('finish', resolve);
            read.pipe(upload);
        });

        await this.deletePrevious({ session, bucket });
    }

    async extract({ session, path: outputPath }) {
        await this.ensureDataPath();
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

        const bucket = this.bucket(session);
        await new Promise((resolve, reject) => {
            const download = bucket.openDownloadStreamByName(`${session}.zip`);
            const write = fs.createWriteStream(outputPath);

            download.once('error', reject);
            write.once('error', reject);
            write.once('finish', resolve);
            download.pipe(write);
        });
    }

    async delete({ session }) {
        const bucket = this.bucket(session);
        const documents = await bucket.find({ filename: `${session}.zip` }).toArray();
        await Promise.allSettled(documents.map((doc) => bucket.delete(doc._id)));
    }

    async deletePrevious({ session, bucket }) {
        const documents = await bucket.find({ filename: `${session}.zip` }).toArray();
        if (documents.length <= 1) return;

        const sorted = documents.sort((left, right) => left.uploadDate - right.uploadDate);
        await Promise.allSettled(sorted.slice(0, -1).map((doc) => bucket.delete(doc._id)));
    }
}

module.exports = { RemoteAuthMongoStore };
