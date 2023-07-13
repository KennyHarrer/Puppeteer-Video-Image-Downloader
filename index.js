const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

class NetworkCache {
    constructor({ bufferLimit = 50 } = {}) {
        this.bufferLimit = bufferLimit; //IN MB
        this.responses = {};
        this.downloadFilter = { media: true /* <- videos */, image: false };
        this.mimeBlacklist = { 'image/svg+xml': true };
    }

    async waitForRequestLoad(requestId) {
        if (!this.responses[requestId]) this.responses[requestId] = {}; //initalize
        if (this.responses[requestId].loaded == true) return; //the request has already been loaded, no need to wait.

        await new Promise((resolve) => {
            this.responses[requestId].loaded = resolve;
        });
    }

    registerRequestLoadEvent(client) {
        client.on('Network.loadingFinished', async ({ requestId }) => {
            if (!this.responses[requestId]) this.responses[requestId] = {}; //initalize
            if (typeof this.responses[requestId].loaded == 'function') {
                //something is waiting for this request to load, resolve promise
                this.responses[requestId].loaded();
            }
            //set to true because this request has loaded,
            this.responses[requestId].loaded = true;
        });
    }

    registerResponseEvent(client) {
        client.on('Network.responseReceived', async (event) => {
            let { requestId, response, type } = event;
            let { url, headers, mimeType } = response;

            if (!this.downloadFilter[type.toLowerCase()]) return; // if i'm not going to be downloaded disregaurd this event
            if (this.mimeBlacklist[mimeType.toLowerCase()]) return;

            //wait for the request to load
            await this.waitForRequestLoad(requestId);
            //request response body

            let responseData;
            try {
                responseData = await client.send('Network.getResponseBody', { requestId });
            } catch (error) {
                if (error.originalMessage == 'Request content was evicted from inspector cache') {
                    throw new Error('Increase bufferLimit in index.js');
                }
                throw error;
            }

            //create buffer from response
            let responseBuffer = Buffer.from(
                responseData.body,
                responseData.base64Encoded ? 'base64' : 'utf8'
            );

            if (type == 'Media') {
                if (!this.responses[requestId].chunks) this.responses[requestId].chunks = []; //initalize
                this.responses[requestId].chunks.push(responseBuffer);
                let { ['content-length']: contentLength, ['content-range']: contentRange } =
                    headers;
                let soFar = Number(contentRange.split(' ').pop().split('-').pop().split('/')[0]);
                let total = Number(contentLength) - 1;
                if (soFar < total) return; //are we still waiting for more chunks
                let video = Buffer.concat(this.responses[requestId].chunks); //concat chunks to form video
                delete this.responses[requestId].chunks;
                this.responses[requestId].video = video;
                this.responses[requestId].save = function (path) {
                    const stream = fs.createWriteStream(path);
                    let promise = new Promise((resolve) => {
                        stream.write(video, () => {
                            stream.close();
                            resolve();
                        });
                    });
                    return promise;
                };
                this.responses[requestId].fileType = url.split('.').pop();
                if (typeof this.responses[requestId].received == 'function') {
                    //something is waiting for this request to be fully received, resolve promise
                    this.responses[requestId].received();
                }
                this.responses[requestId].received = true;
            } else if (type == 'Image') {
                /*
                let fileType = mimeType.split('/').pop();
                const stream = fs.createWriteStream(
                    path.resolve(downloadPath, generateRandomFileName(10) + '.' + fileType)
                );
                stream.write(responseBuffer, () => {
                    stream.close();
                });*/
            } else {
                console.log('unsupported type ', type);
            }
        });
    }

    async use(pageInstance) {
        const client = await pageInstance.target().createCDPSession();

        await client.send('Network.enable', {
            maxResourceBufferSize: 1024 * 1024 * this.bufferLimit,
            maxTotalBufferSize: 1024 * 1024 * this.bufferLimit,
        });

        this.registerRequestLoadEvent(client);

        this.registerResponseEvent(client);

        pageInstance.GetCachedResponses = () => {
            return this.responses;
        };

        pageInstance.WaitForRequestReceived = async (requestId) => {
            if (this.responses[requestId].received == true) return; //the request has already been received, no need to wait.
            return new Promise((resolve) => {
                //this promise will be resolved when the request has loaded.
                this.responses[requestId].received = resolve;
            });
        };
    }
}

(async () => {
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--autoplay-policy=no-user-gesture-required'],
    });

    let page = await browser.newPage();

    let networkCache = new NetworkCache();

    await networkCache.use(page);

    await page.goto('https://example-img-and-video.triggeredforday.repl.co/');

    await page.waitForNetworkIdle();

    let cached = await page.GetCachedResponses();

    for (let cachedMedia of Object.values(cached)) {
        if (cachedMedia.save) {
            await cachedMedia.save(
                path.resolve(
                    path.resolve(__dirname, 'downloads'),
                    Math.random() + '.' + cachedMedia.fileType
                )
            );
        }
    }

    console.log(cached);
})();
