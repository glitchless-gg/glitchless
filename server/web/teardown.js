#!/usr/bin/env node
// Removes everything deploy.js created: the Web Function (endpoints + revisions), the DynamoDB table,
// the IAM role and the deploy bucket. Asks for confirmation unless --yes is passed.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DynamoDBClient, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { IAMClient, DeleteRoleCommand, DeleteRolePolicyCommand } from '@aws-sdk/client-iam';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { LambdaWebClient, DeleteWebFunctionCommand } from '@aws-sdk/client-lambda-web';
import { ROOT } from '../src/config.js';

const STATE_FILE = path.join(ROOT, '.glitchless-aws.json');
if (!fs.existsSync(STATE_FILE)) {
  console.log('Nothing to tear down (.glitchless-aws.json not found).');
  process.exit(0);
}
const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
console.log(`This permanently deletes:\n  web function ${s.function}\n  DynamoDB table ${s.table} (all telemetry)\n  IAM role ${s.role}\n  S3 bucket ${s.bucket}\n  in ${s.region}`);
if (!process.argv.includes('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "delete" to continue: ');
  rl.close();
  if (answer.trim() !== 'delete') process.exit(1);
}
const step = async (label, fn) => {
  try {
    await fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    console.log(`… ${label}: ${err.name} ${err.message}`);
  }
};
await step('web function', () => new LambdaWebClient({ region: s.region }).send(new DeleteWebFunctionCommand({ functionName: s.function })));
await step('table', () => new DynamoDBClient({ region: s.region }).send(new DeleteTableCommand({ TableName: s.table })));
const iam = new IAMClient({ region: s.region });
await step('role', async () => {
  await iam.send(new DeleteRolePolicyCommand({ RoleName: s.role, PolicyName: 'glitchless' }));
  await iam.send(new DeleteRoleCommand({ RoleName: s.role }));
});
const s3 = new S3Client({ region: s.region });
await step('bucket', async () => {
  const v = await s3.send(new ListObjectVersionsCommand({ Bucket: s.bucket }));
  const objects = [...(v.Versions || []), ...(v.DeleteMarkers || [])].map((o) => ({ Key: o.Key, VersionId: o.VersionId }));
  if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: s.bucket, Delete: { Objects: objects } }));
  await s3.send(new DeleteBucketCommand({ Bucket: s.bucket }));
});
fs.renameSync(STATE_FILE, STATE_FILE + '.deleted');
