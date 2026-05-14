/**
 * lib/b2.js — Singleton Backblaze B2 (S3-compatible) client.
 * Usage: const { getB2, B2_BUCKET } = require('../lib/b2');
 *        const b2 = getB2();
 *
 * Parses B2_ENDPOINT env var and extracts region automatically.
 * Singleton: one S3Client per cold start, re-used on warm invocations.
 */

const { S3Client } = require('@aws-sdk/client-s3');

const rawEndpoint = process.env.B2_ENDPOINT || '';
const B2_ENDPOINT = rawEndpoint.startsWith('http')
    ? rawEndpoint
    : `https://${rawEndpoint || 's3.us-east-005.backblazeb2.com'}`;

const extractedRegion = (B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || 'us-east-005';

const B2_BUCKET = process.env.B2_BUCKET_NAME;

let _b2Client = null;

function getB2() {
    if (!_b2Client) {
        _b2Client = new S3Client({
            region: extractedRegion,
            endpoint: B2_ENDPOINT,
            credentials: {
                accessKeyId: process.env.B2_KEY_ID,
                secretAccessKey: process.env.B2_APPLICATION_KEY,
            },
            forcePathStyle: true,
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        });
    }
    return _b2Client;
}

module.exports = { getB2, B2_BUCKET, B2_ENDPOINT, extractedRegion };
