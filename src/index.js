import convert from './convert'; // GeoJSON conversion and preprocessing
import clip from './clip'; // stripe clipping algorithm
import wrap from './wrap'; // date line processing
import transform from './transform'; // coordinate transformation
import createTile from './tile'; // final simplified tile generation
var _ = require("underscore");
var Readable = require('stream').Readable;

export default function geojsonvt(data, options) {
    return new GeoJSONVT(data, options);
}

function GeoJSONVT(data, options) {
    options = this.options = extend(Object.create(this.options), options);

    const debug = options.debug;

    const useStream = options.useStream;


    if (debug) console.time('preprocess data');

    if (options.maxZoom < 0 || options.maxZoom > 24) throw new Error('maxZoom should be in the 0-24 range');
    if (options.promoteId && options.generateId) throw new Error('promoteId and generateId cannot be used together.');


    let features = convert(data, options);

    this.tiles = {};
    this.tileCoords = [];

    if (debug) {
        console.timeEnd('preprocess data');
        console.log('index: maxZoom: %d, maxPoints: %d', options.indexMaxZoom, options.indexMaxPoints);
        console.time('generate tiles');
        this.stats = {};
        this.total = 0;
    }

    features = wrap(features, options);

    // start slicing from the top tile down
    if (features.length) this.splitTile(features, 0, 0, 0);

    if (debug && !useStream) {
        if (features.length) console.log('features: %d, points: %d', this.tiles[0].numFeatures, this.tiles[0].numPoints);
        console.timeEnd('generate tiles');
        console.log('tiles generated:', this.total, JSON.stringify(this.stats));
    }
}

GeoJSONVT.prototype.options = {
    maxZoom: 14, // max zoom to preserve detail on
    indexMaxZoom: 5, // max zoom in the tile index
    indexMaxPoints: 100000, // max number of points per tile in the tile index
    tolerance: 3, // simplification tolerance (higher means simpler)
    extent: 4096, // tile extent
    buffer: 64, // tile buffer on each side
    lineMetrics: false, // whether to calculate line metrics
    promoteId: null, // name of a feature property to be promoted to feature.id
    generateId: false, // whether to generate feature ids. Cannot be used with promoteId
    debug: 0, // logging level (0, 1 or 2)
    useStream: false, // option for emitting tiles to a stream as they are generated. Will not be usable as a normal tileIndex if true, as stream is self-cleaning to keep memory down as much as possible.
    streamObject: true, // if streaming, the default mode to stream with is in object mode, instead of string/buffer mode
    debugStream: false, //display streaming debug logs
    clearStreamIfMoreThanXCached: 1000 //clear the stream if more than X tiles are cached.
};

GeoJSONVT.prototype.splitTile = function(features, z, x, y, cz, cx, cy, persist = true) {

    const stack = [features, z, x, y];
    const options = this.options;
    const debug = options.debug;
    const useStream = options.useStream;
    const extent = options.extent;
    const debugStream = options.debugStream;

    // console.log(options)


    if (debugStream) console.log("writing to stream")

    if (useStream) {
        var rs = new Readable({
            objectMode: true,
        });
        this.rs = rs;
        rs.tileCounter = 0;
        rs.stack = stack;
        rs.lastZ = null;
        rs.tilesSinceLastClear = 0;
        rs.tiles = this.tiles;
        rs.tileCoords = this.tileCoords;
        
        rs._read = function() {

            // while (this.stack.length) {
            y = this.stack.pop();
            x = this.stack.pop();
            z = this.stack.pop();
            features = this.stack.pop();

            // console.log(z,x,y)

            if(z===undefined && x===undefined && y===undefined){
                rs.push(null);
                return
            }

            if (this.tilesSinceLastClear >= options.clearStreamIfMoreThanXCached) {
                if (debug > 0 || debugStream) console.log("tiles haven't been cycled recently, forcing cycle")
                this.tiles = {};
                this.tiles = [];
                this.tilesSinceLastClear = 0;
            }

            const z2 = 1 << z;
            const id = toID(z, x, y);
            let tile = this.tiles[id];

            

            if (!tile) {
                if (debug > 1) console.time('creation');

                tile = this.tiles[id] = createTile(features, z, x, y, options);
                this.tileCoords.push({ z, x, y });
                // console.log(`lastZ:${lastZ}, tile.z:${tile.z}`)
                // if (debug > 1 && computeonly) { console.log("tile is computeonly") }
                // if (useStream) {
                // if(useStream) {}
                if(options.streamObject === true){
                    rs.push(transform(this.tiles[id], options.extent));    
                }
                else{
                    rs.push(transform(JSON.stringify(this.tiles[id], options.extent)));       
                }
                
                this.tileCounter++;
                // console.log(`generated ${this.tileCounter} tiles`)
                if (this.lastZ === null) {
                    this.lastZ = tile.z
                }

                if (tile.z === this.lastZ + 2) { //once an n+2 layer is reached, start deleting the parent tiles above it as they will have been passed already.
                    if (debugStream) console.log("finding keys to omit")
                    var omitKeys = _.filter(this.tileCoords, (key) => { return key.z === this.lastZ });
                    // if(debug > 1)console.timeEnd("finding keys to omit")
                    if (debugStream) console.log(`will omit ${JSON.stringify(omitKeys)} b/c on zoom level ${tile.z}`)
                    if (debugStream) console.log("generating ids to omit")
                    var omitIds = _.map(omitKeys, (key) => { return toID(key.z, key.x, key.y) });
                    // if(debug > 1)console.timeEnd("generating ids to omit")
                    if (debugStream) console.log("omitting keys")
                    this.tileCoords = _.reject(this.tileCoords, (akey) => {
                        return _.some(omitKeys, (bkey) => {
                            return akey.z === bkey.z && akey.x === bkey.x && akey.y === bkey.y
                        });
                    });
                    // if(debug > 1)console.timeEnd("omitting keys")
                    if (debugStream) console.log("omitting tiles")
                    this.tiles = _.omit(this.tiles, omitIds);
                    // if(debug > 1)console.timeEnd("omitting tiles")
                    if (debugStream) console.log(`now have ${_.keys(this.tiles).length} tiles cached`)
                    this.lastZ += 1; //increment to the next 
                    this.tilesSinceLastClear = 0;
                }
                this.tilesSinceLastClear++;

                // }


                if (debug) {
                    if (debug > 1) {
                        console.log('tile z%d-%d-%d (features: %d, points: %d, simplified: %d)',
                            z, x, y, tile.numFeatures, tile.numPoints, tile.numSimplified);
                        console.timeEnd('creation');
                    }
                    const key = `z${  z}`;
                    this.stats[key] = (this.stats[key] || 0) + 1;
                    this.total++;
                }
            }

            // save reference to original geometry in tile so that we can drill down later if we stop now
            tile.source = features;

            // if it's the first-pass tiling
            if (!cz) {
                // stop tiling if we reached max zoom, or if the tile is too simple
                if (z === options.indexMaxZoom || tile.numPoints <= options.indexMaxPoints) return;

                // if a drilldown to a specific tile
            } else {
                // stop tiling if we reached base zoom or our target tile zoom
                if (z === options.maxZoom || z === cz) return;

                // stop tiling if it's not an ancestor of the target tile
                const m = 1 << (cz - z);
                if (x !== Math.floor(cx / m) || y !== Math.floor(cy / m)) return;
            }

            // if we slice further down, no need to keep source geometry
            tile.source = null;

            if (features.length === 0) return;


            if (debug > 1) console.time('clipping');

            // values we'll use for clipping
            const k1 = 0.5 * options.buffer / options.extent;
            const k2 = 0.5 - k1;
            const k3 = 0.5 + k1;
            const k4 = 1 + k1;

            let tl = null;
            let bl = null;
            let tr = null;
            let br = null;

            let left = clip(features, z2, x - k1, x + k3, 0, tile.minX, tile.maxX, options);
            let right = clip(features, z2, x + k2, x + k4, 0, tile.minX, tile.maxX, options);
            features = null;

            if (left) {
                tl = clip(left, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options);
                bl = clip(left, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options);
                left = null;
            }

            if (right) {
                tr = clip(right, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options);
                br = clip(right, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options);
                right = null;
            }

            if (debug > 1) console.timeEnd('clipping');

            this.stack.push(tl || [], z + 1, x * 2, y * 2);
            this.stack.push(bl || [], z + 1, x * 2, y * 2 + 1);
            this.stack.push(tr || [], z + 1, x * 2 + 1, y * 2);
            this.stack.push(br || [], z + 1, x * 2 + 1, y * 2 + 1);
            // }
            // if (debugStream && useStream) console.log("stream generation end")
            // if (useStream) rs.push(null);
        }

    } else {
        // avoid recursion by using a processing queue

        while (stack.length) {
            y = stack.pop();
            x = stack.pop();
            z = stack.pop();
            features = stack.pop();

            // console.log(y,x,z)

            const z2 = 1 << z;
            const id = toID(z, x, y);
            let tile = this.tiles[id];

            if (!tile) {
                // if (debug > 1) console.time('creation');

                tile = this.tiles[id] = createTile(features, z, x, y, options);
                this.tileCoords.push({ z, x, y });
                if (debug) {
                    if (debug > 1) {
                        console.log('tile z%d-%d-%d (features: %d, points: %d, simplified: %d)',
                            z, x, y, tile.numFeatures, tile.numPoints, tile.numSimplified);
                        // console.timeEnd('creation');
                    }
                    const key = `z${  z}`;
                    this.stats[key] = (this.stats[key] || 0) + 1;
                    this.total++;
                }
            }

            // save reference to original geometry in tile so that we can drill down later if we stop now
            tile.source = features;

            // if it's the first-pass tiling
            if (!cz) {
                // stop tiling if we reached max zoom, or if the tile is too simple
                if (z === options.indexMaxZoom || tile.numPoints <= options.indexMaxPoints) continue;

                // if a drilldown to a specific tile
            } else {
                // stop tiling if we reached base zoom or our target tile zoom
                if (z === options.maxZoom || z === cz) continue;

                // stop tiling if it's not an ancestor of the target tile
                const m = 1 << (cz - z);
                if (x !== Math.floor(cx / m) || y !== Math.floor(cy / m)) continue;
            }

            // if we slice further down, no need to keep source geometry
            tile.source = null;

            if (features.length === 0) continue;

            if (debug > 1) console.time('clipping');

            // values we'll use for clipping
            const k1 = 0.5 * options.buffer / options.extent;
            const k2 = 0.5 - k1;
            const k3 = 0.5 + k1;
            const k4 = 1 + k1;

            let tl = null;
            let bl = null;
            let tr = null;
            let br = null;

            let left = clip(features, z2, x - k1, x + k3, 0, tile.minX, tile.maxX, options);
            let right = clip(features, z2, x + k2, x + k4, 0, tile.minX, tile.maxX, options);
            features = null;

            if (left) {
                tl = clip(left, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options);
                bl = clip(left, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options);
                left = null;
            }

            if (right) {
                tr = clip(right, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options);
                br = clip(right, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options);
                right = null;
            }

            if (debug > 1) console.timeEnd('clipping');

            stack.push(tl || [], z + 1, x * 2, y * 2);
            stack.push(bl || [], z + 1, x * 2, y * 2 + 1);
            stack.push(tr || [], z + 1, x * 2 + 1, y * 2);
            stack.push(br || [], z + 1, x * 2 + 1, y * 2 + 1);
        }
        console.log("normal generation end")
    }



};

GeoJSONVT.prototype.getTile = function(z, x, y, persist = true, returnbranch = false) {
    z = +z;
    x = +x;
    y = +y;

    const options = this.options;
    const { extent, debug } = options;

    if (z < 0 || z > 24) return null;

    const z2 = 1 << z;
    x = ((x % z2) + z2) % z2; // wrap tile x coordinate

    const id = toID(z, x, y);
    if (this.tiles[id]) return transform(this.tiles[id], extent);

    if (debug > 1) console.log('drilling down to z%d-%d-%d', z, x, y);

    let z0 = z;
    let x0 = x;
    let y0 = y;
    let parent;

    while (!parent && z0 > 0) {
        z0--;
        x0 = Math.floor(x0 / 2);
        y0 = Math.floor(y0 / 2);
        parent = this.tiles[toID(z0, x0, y0)];
    }

    if (!parent || !parent.source) return null;

    // if we found a parent tile containing the original geometry, we can drill down from it
    if (debug > 1) console.log('found parent tile z%d-%d-%d', z0, x0, y0);

    if (debug > 1) console.time('drilling down');
    this.splitTile(parent.source, z0, x0, y0, z, x, y, persist);
    if (debug > 1) console.timeEnd('drilling down');

    if (persist === true) {
        return this.tiles[id] ? transform(this.tiles[id], extent) : null;
    } else {
        //find the index in the tile coords which has the key
        var breakIdx = _.findIndex(this.tileCoords, (tilekey) => {
            return tilekey.z === z && tilekey.x === x && tilekey.y === y
        });

        // console.log(breakIdx)
        // console.log(this.tileCoords)
        var spike = this.tileCoords.slice(0, breakIdx + 1)
        var sorted = _.sortBy(spike, (obj) => {
            return obj.z;
        }).reverse();
        // console.log(sorted)
        var tileArray = _.map(sorted, (key) => { return this.tiles[toID(key.z, key.x, key.y)] })
        if (debug > 1) console.log("cleaning tiles")
        this.tiles = {};
        if (debug > 1) console.log("cleaning tileCoords")
        this.tileCoords = [];

        if (returnbranch) {
            if (debug > 1) console.log("returning tile with branch")
            return tileArray
        } else {
            if (debug > 1) console.log("returning tile")
            return tileArray[0]
        }

    }
};

function toID(z, x, y) {
    return (((1 << z) * y + x) * 32) + z;
}

function extend(dest, src) {
    for (const i in src) dest[i] = src[i];
    return dest;
}