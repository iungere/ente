import {
    DEFAULT_ML_SYNC_CONFIG,
    DEFAULT_ML_SYNC_JOB_CONFIG,
} from 'constants/machineLearning/config';
import {
    openDB,
    deleteDB,
    DBSchema,
    IDBPDatabase,
    IDBPTransaction,
    StoreNames,
} from 'idb';
import { Config } from 'types/common/config';
import { Face, MlFileData, MLLibraryData, Person } from 'types/machineLearning';
import { runningInBrowser } from 'utils/common';

export const ML_SYNC_JOB_CONFIG_NAME = 'ml-sync-job';
export const ML_SYNC_CONFIG_NAME = 'ml-sync';

const MLDATA_DB_NAME = 'mldata';
interface MLDb extends DBSchema {
    files: {
        key: number;
        value: MlFileData;
        indexes: { mlVersion: [number, number] };
    };
    people: {
        key: number;
        value: Person;
    };
    versions: {
        key: string;
        value: number;
    };
    library: {
        key: string;
        value: MLLibraryData;
    };
    configs: {
        key: string;
        value: Config;
    };
}

class MLIDbStorage {
    public db: Promise<IDBPDatabase<MLDb>>;

    constructor() {
        if (!runningInBrowser()) {
            return;
        }

        this.db = openDB<MLDb>(MLDATA_DB_NAME, 2, {
            upgrade(db, oldVersion, newVersion, tx) {
                if (oldVersion < 1) {
                    const filesStore = db.createObjectStore('files', {
                        keyPath: 'fileId',
                    });
                    filesStore.createIndex('mlVersion', [
                        'mlVersion',
                        'errorCount',
                    ]);

                    db.createObjectStore('people', {
                        keyPath: 'id',
                    });

                    db.createObjectStore('versions');

                    db.createObjectStore('library');
                }
                if (oldVersion < 2) {
                    // TODO: update configs if version is updated in defaults
                    db.createObjectStore('configs');

                    tx.objectStore('configs').add(
                        DEFAULT_ML_SYNC_JOB_CONFIG,
                        ML_SYNC_JOB_CONFIG_NAME
                    );
                    tx.objectStore('configs').add(
                        DEFAULT_ML_SYNC_CONFIG,
                        ML_SYNC_CONFIG_NAME
                    );
                }
            },
        });
    }

    public async clearMLDB() {
        const db = await this.db;
        db.close();
        return deleteDB(MLDATA_DB_NAME);
    }

    public async getAllFileIds() {
        const db = await this.db;
        return db.getAllKeys('files');
    }

    public async putAllFilesInTx(mlFiles: Array<MlFileData>) {
        const db = await this.db;
        const tx = db.transaction('files', 'readwrite');
        await Promise.all(mlFiles.map((mlFile) => tx.store.put(mlFile)));
        await tx.done;
    }

    public async removeAllFilesInTx(fileIds: Array<number>) {
        const db = await this.db;
        const tx = db.transaction('files', 'readwrite');

        await Promise.all(fileIds.map((fileId) => tx.store.delete(fileId)));
        await tx.done;
    }

    public async newTransaction<
        Name extends StoreNames<MLDb>,
        Mode extends IDBTransactionMode = 'readonly'
    >(storeNames: Name, mode?: Mode) {
        const db = await this.db;
        return db.transaction(storeNames, mode);
    }

    public async commit(tx: IDBPTransaction<MLDb>) {
        return tx.done;
    }

    public async getAllFileIdsForUpdate(
        tx: IDBPTransaction<MLDb, ['files'], 'readwrite'>
    ) {
        return tx.store.getAllKeys();
    }

    public async getFileIds(
        count: number,
        limitMlVersion: number,
        maxErrorCount: number
    ) {
        const db = await this.db;
        const tx = db.transaction('files', 'readonly');
        const index = tx.store.index('mlVersion');
        let cursor = await index.openKeyCursor(
            IDBKeyRange.upperBound([limitMlVersion], true)
        );

        const fileIds: number[] = [];
        while (cursor && fileIds.length < count) {
            if (
                cursor.key[0] < limitMlVersion &&
                cursor.key[1] <= maxErrorCount
            ) {
                fileIds.push(cursor.primaryKey);
            }
            cursor = await cursor.continue();
        }
        await tx.done;

        return fileIds;
    }

    public async getFile(fileId: number) {
        const db = await this.db;
        return db.get('files', fileId);
    }

    public async getAllFiles() {
        const db = await this.db;
        return db.getAll('files');
    }

    public async putFile(mlFile: MlFileData) {
        const db = await this.db;
        return db.put('files', mlFile);
    }

    public async upsertFileInTx(
        fileId: number,
        upsert: (mlFile: MlFileData) => MlFileData
    ) {
        const db = await this.db;
        const tx = db.transaction('files', 'readwrite');
        const existing = await tx.store.get(fileId);
        const updated = upsert(existing);
        await tx.store.put(updated);
        await tx.done;

        return updated;
    }

    public async putAllFiles(
        mlFiles: Array<MlFileData>,
        tx: IDBPTransaction<MLDb, ['files'], 'readwrite'>
    ) {
        await Promise.all(mlFiles.map((mlFile) => tx.store.put(mlFile)));
    }

    public async removeAllFiles(
        fileIds: Array<number>,
        tx: IDBPTransaction<MLDb, ['files'], 'readwrite'>
    ) {
        await Promise.all(fileIds.map((fileId) => tx.store.delete(fileId)));
    }

    public async getAllFacesMap() {
        console.time('getAllFacesMap');
        const db = await this.db;
        const allFiles = await db.getAll('files');
        const allFacesMap = new Map<number, Array<Face>>();
        allFiles.forEach(
            (mlFileData) =>
                mlFileData.faces &&
                allFacesMap.set(mlFileData.fileId, mlFileData.faces)
        );
        console.timeEnd('getAllFacesMap');

        return allFacesMap;
    }

    public async updateFaces(allFacesMap: Map<number, Face[]>) {
        console.time('updateFaces');
        const db = await this.db;
        const tx = db.transaction('files', 'readwrite');
        let cursor = await tx.store.openCursor();
        while (cursor) {
            if (allFacesMap.has(cursor.key)) {
                const mlFileData = { ...cursor.value };
                mlFileData.faces = allFacesMap.get(cursor.key);
                cursor.update(mlFileData);
            }
            cursor = await cursor.continue();
        }
        await tx.done;
        console.timeEnd('updateFaces');
    }

    public async getPerson(id: number) {
        const db = await this.db;
        return db.get('people', id);
    }

    public async getAllPeople() {
        const db = await this.db;
        return db.getAll('people');
    }

    public async putPerson(person: Person) {
        const db = await this.db;
        return db.put('people', person);
    }

    public async clearAllPeople() {
        const db = await this.db;
        return db.clear('people');
    }

    public async getIndexVersion(index: string) {
        const db = await this.db;
        return db.get('versions', index);
    }

    public async incrementIndexVersion(index: string) {
        const db = await this.db;
        const tx = db.transaction('versions', 'readwrite');
        let version = await tx.store.get(index);
        version = (version || 0) + 1;
        tx.store.put(version, index);
        await tx.done;

        return version;
    }

    public async setIndexVersion(index: string, version: number) {
        const db = await this.db;
        return db.put('versions', version, index);
    }

    public async getLibraryData() {
        const db = await this.db;
        return db.get('library', 'data');
    }

    public async putLibraryData(data: MLLibraryData) {
        const db = await this.db;
        return db.put('library', data, 'data');
    }

    public async getConfig<T extends Config>(name: string, def: T) {
        const db = await this.db;
        const tx = db.transaction('configs', 'readwrite');
        let config = (await tx.store.get(name)) as T;
        if (!config) {
            config = def;
            await tx.store.put(def, name);
        }
        await tx.done;

        return config;
    }

    public async putConfig(name: string, data: Config) {
        const db = await this.db;
        return db.put('configs', data, name);
    }

    // for debug purpose
    public async getAllMLData() {
        const db = await this.db;
        const tx = db.transaction(db.objectStoreNames, 'readonly');
        const allMLData: any = {};
        for (const store of tx.objectStoreNames) {
            const keys = await tx.objectStore(store).getAllKeys();
            const data = await tx.objectStore(store).getAll();

            allMLData[store] = {};
            for (let i = 0; i < keys.length; i++) {
                allMLData[store][keys[i]] = data[i];
            }
        }
        await tx.done;

        const files = allMLData['files'];
        for (const fileId of Object.keys(files)) {
            const fileData = files[fileId];
            fileData.faces?.forEach(
                (f) => (f.embedding = Array.from(f.embedding))
            );
        }

        return allMLData;
    }

    // for debug purpose, this will overwrite all data
    public async putAllMLData(allMLData: Map<string, any>) {
        const db = await this.db;
        const tx = db.transaction(db.objectStoreNames, 'readwrite');
        for (const store of tx.objectStoreNames) {
            const records = allMLData[store];
            if (!records) {
                continue;
            }
            const txStore = tx.objectStore(store);

            if (store === 'files') {
                const files = records;
                for (const fileId of Object.keys(files)) {
                    const fileData = files[fileId];
                    fileData.faces?.forEach(
                        (f) => (f.embedding = Float32Array.from(f.embedding))
                    );
                }
            }

            await txStore.clear();
            for (const key of Object.keys(records)) {
                if (txStore.keyPath) {
                    txStore.put(records[key]);
                } else {
                    txStore.put(records[key], key);
                }
            }
        }
        await tx.done;
    }
}

export default new MLIDbStorage();
