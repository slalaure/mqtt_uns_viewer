/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 */

const fs = require('fs');

/**
 * Native Node.js implementation to read the last N lines of a file.
 * Memory-efficiently seeks from the end of the file in chunks.
 * 
 * @param {string} filePath Path to the file.
 * @param {number} maxLines Number of lines to retrieve.
 * @param {number} [chunkSize] Size of the buffer for each read (default: 64KB).
 * @returns {Promise<string>} The last N lines of the file.
 */
async function readLastLines(filePath, maxLines, chunkSize = 65536) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            return reject(new Error(`File not found: ${filePath}`));
        }

        fs.open(filePath, 'r', (err, fd) => {
            if (err) return reject(err);

            fs.fstat(fd, (err, stats) => {
                if (err) {
                    fs.close(fd, () => {});
                    return reject(err);
                }

                let fileSize = stats.size;
                if (fileSize === 0) {
                    fs.close(fd, () => resolve(''));
                    return;
                }

                let buffer = Buffer.alloc(chunkSize);
                let linesCount = 0;
                let position = fileSize;
                let lastLinesBuffer = Buffer.alloc(0);

                const readNextChunk = () => {
                    const currentReadSize = Math.min(position, chunkSize);
                    position -= currentReadSize;

                    fs.read(fd, buffer, 0, currentReadSize, position, (err, bytesRead) => {
                        if (err) {
                            fs.close(fd, () => {});
                            return reject(err);
                        }

                        const currentChunk = buffer.slice(0, bytesRead);
                        
                        // Count newlines from the end of the current chunk
                        for (let i = bytesRead - 1; i >= 0; i--) {
                            // \n = 10
                            if (currentChunk[i] === 10) {
                                // Skip very last newline of the file for count
                                if (position + i === fileSize - 1) continue;

                                linesCount++;
                                if (linesCount === maxLines) {
                                    // Found enough lines! Extract from here to end.
                                    const startPos = i + 1;
                                    const finalBuffer = Buffer.concat([currentChunk.slice(startPos), lastLinesBuffer]);
                                    fs.close(fd, () => resolve(finalBuffer.toString('utf8')));
                                    return;
                                }
                            }
                        }

                        // Prep for next chunk
                        lastLinesBuffer = Buffer.concat([currentChunk, lastLinesBuffer]);

                        if (position > 0) {
                            readNextChunk();
                        } else {
                            // Reached beginning of file
                            fs.close(fd, () => resolve(lastLinesBuffer.toString('utf8')));
                        }
                    });
                };

                readNextChunk();
            });
        });
    });
}

module.exports = {
    readLastLines
};
