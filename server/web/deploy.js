#!/usr/bin/env node
// One-command deploy of Glitchless to AWS Lambda Web Functions + DynamoDB.
//
//   node server/web/deploy.js            # build, package, create/update everything, print the URL
//   node server/web/deploy.js --no-build # reuse existing dist/ builds
//
// Creates (idempotently): DynamoDB table (on-demand, TTL), IAM execution role, versioned S3 deploy
// bucket, and a Web Function with a public (ApplicationManaged) HomeRegion endpoint, rate limited.
// Uses the AWS SDK directly, so it works without the newest AWS CLI. Tear down with teardown.js.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { build } from 'esbuild';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBClient, DescribeTableCommand, CreateTableCommand, UpdateTimeToLiveCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { IAMClient, GetRoleCommand, CreateRoleCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketVersioningCommand, PutBucketPolicyCommand, PutObjectCommand, PutPublicAccessBlockCommand } from '@aws-sdk/client-s3';
import { LambdaWebClient, GetWebFunctionCommand, CreateWebFunctionCommand, CreateWebFunctionRevisionCommand, GetWebFunctionRevisionCommand, GetWebFunctionEndpointCommand } from '@aws-sdk/client-lambda-web';
import { ROOT, loadEnv } from '../src/config.js';

loadEnv();
const REGION = process.env.GLITCHLESS_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
const NAME = process.env.GLITCHLESS_FUNCTION || 'glitchless-selfhost';
const TABLE = process.env.GLITCHLESS_EVENTS_TABLE || 'glitchless-selfhost-events';
const ROLE = `${NAME}-web-function`;
const ENDPOINT = 'prod';
const OUT = path.join(ROOT, '.build/web');
const STATE_FILE = path.join(ROOT, '.glitchless-aws.json');
const skipBuild = process.argv.includes('--no-build');

const log = (...a) => console.log('›', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};

const sts = new STSClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const web = new LambdaWebClient({ region: REGION });

const { Account } = await sts.send(new GetCallerIdentityCommand({}));
log(`account ${Account}, region ${REGION}`);

// ── 1. build + package ──────────────────────────────────────────
if (!skipBuild) {
  log('building SDK, dashboard and demo game…');
  execSync('npm run build -w glitchless && npm run build -w glitchless-dashboard', { cwd: ROOT, stdio: 'inherit' });
  execSync('npm run build -w zoomies', { cwd: ROOT, stdio: 'inherit', env: { ...process.env, VITE_GLITCHLESS_INTAKE: 'same-origin' } });
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
await build({
  entryPoints: [path.join(ROOT, 'server/web/entry.js')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: path.join(OUT, 'index.js'),
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ type: 'module', private: true }));
const copy = (from, to) => fs.existsSync(from) && fs.cpSync(from, path.join(OUT, 'public', to), { recursive: true });
copy(path.join(ROOT, 'apps/dashboard/dist'), 'dashboard');
copy(path.join(ROOT, 'apps/zoomies/dist'), 'play');
copy(path.join(ROOT, 'packages/sdk/dist'), 'sdk');
fs.mkdirSync(path.join(OUT, 'public/brand'), { recursive: true });
for (const f of ['png/glitchless-icon-256.png', 'png/glitchless-lockup-light.png', 'favicon.svg']) fs.copyFileSync(path.join(ROOT, 'assets/brand/glitchless/logo', f), path.join(OUT, 'public/brand', path.basename(f)));
const zipPath = path.join(ROOT, '.build/glitchless-web.zip');
fs.rmSync(zipPath, { force: true });
execSync(`cd "${OUT}" && zip -qr "${zipPath}" .`);
log(`packaged ${(fs.statSync(zipPath).size / 1e6).toFixed(1)} MB`);

// ── 2. DynamoDB ──────────────────────────────────────────────────
try {
  await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
  log(`table ${TABLE} exists`);
} catch (err) {
  if (err.name !== 'ResourceNotFoundException') throw err;
  log(`creating table ${TABLE} (on-demand)…`);
  await ddb.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      Tags: [{ Key: 'app', Value: 'glitchless' }],
    }),
  );
  await waitUntilTableExists({ client: ddb, maxWaitTime: 120 }, { TableName: TABLE });
  await ddb.send(new UpdateTimeToLiveCommand({ TableName: TABLE, TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' } }));
}

// ── 3. IAM execution role ────────────────────────────────────────
let roleArn;
try {
  roleArn = (await iam.send(new GetRoleCommand({ RoleName: ROLE }))).Role.Arn;
  log(`role ${ROLE} exists`);
} catch (err) {
  if (err.name !== 'NoSuchEntityException') throw err;
  log(`creating role ${ROLE}…`);
  roleArn = (
    await iam.send(
      new CreateRoleCommand({
        RoleName: ROLE,
        AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }),
        Tags: [{ Key: 'app', Value: 'glitchless' }],
      }),
    )
  ).Role.Arn;
  await sleep(10_000); // IAM is eventually consistent
}
await iam.send(
  new PutRolePolicyCommand({
    RoleName: ROLE,
    PolicyName: 'glitchless',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource: [`arn:aws:logs:${REGION}:${Account}:log-group:/aws/lambda/web/${NAME}:*`, `arn:aws:logs:*:${Account}:log-group:/aws/lambda/web/${NAME}.local:*`],
        },
        {
          Effect: 'Allow',
          Action: ['dynamodb:PutItem', 'dynamodb:BatchWriteItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:GetItem'],
          Resource: `arn:aws:dynamodb:${REGION}:${Account}:table/${TABLE}`,
        },
      ],
    }),
  }),
);

// ── 4. versioned deploy bucket ───────────────────────────────────
const BUCKET = `glitchless-selfhost-deploy-${Account}-${REGION}`;
try {
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
} catch {
  log(`creating bucket ${BUCKET}…`);
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET, ...(REGION === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: REGION } }) }));
  await s3.send(new PutPublicAccessBlockCommand({ Bucket: BUCKET, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
  await s3.send(new PutBucketVersioningCommand({ Bucket: BUCKET, VersioningConfiguration: { Status: 'Enabled' } }));
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: BUCKET,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'LambdaWebFunctionsRead',
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: ['s3:GetObject', 's3:GetObjectVersion'],
            Resource: `arn:aws:s3:::${BUCKET}/*`,
            Condition: { StringEquals: { 'aws:SourceAccount': Account } },
          },
        ],
      }),
    }),
  );
}
const key = `lambda-web/${NAME}/glitchless-web.zip`;
const put = await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: fs.readFileSync(zipPath) }));
log(`uploaded s3://${BUCKET}/${key} (version ${put.VersionId})`);

// ── 5. Web Function ──────────────────────────────────────────────
state.apiKey ||= 'gl_read_' + crypto.randomBytes(12).toString('hex');
state.clientToken ||= 'gl_pub_' + crypto.randomBytes(6).toString('hex');
const ddKey = process.env.DD_API_KEY || process.env.DATADOG_KEY || '';
// OTLP export: the standard OpenTelemetry exporter variables pass straight through.
const OTLP_VARS = /^(OTEL_EXPORTER_OTLP_\w+|OTEL_(METRICS|LOGS)_EXPORTER|OTEL_METRIC_EXPORT_INTERVAL|OTEL_RESOURCE_ATTRIBUTES|OTEL_SDK_DISABLED|GLITCHLESS_OTLP)$/;
const otlpEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => OTLP_VARS.test(k) && v));
const buildConfig = { codeConfig: { s3Object: { bucket: BUCKET, key, versionId: put.VersionId } }, runtimeConfig: { runtime: 'nodejs24.x' } };
const serviceConfig = {
  executionRoleArn: roleArn,
  timeoutSeconds: 30,
  maxConcurrencyPerEnvironment: 64,
  environmentVariables: {
    GLITCHLESS_EVENTS_TABLE: TABLE,
    GLITCHLESS_REGION: REGION,
    GLITCHLESS_API_KEY: state.apiKey,
    GLITCHLESS_CLIENT_TOKENS: `gl_pub_dev,${state.clientToken}`,
    ...(ddKey ? { DD_API_KEY: ddKey, DD_SITE: process.env.DD_SITE || 'datadoghq.com' } : {}),
    ...otlpEnv,
  },
};

let revisionId;
let exists = true;
try {
  await web.send(new GetWebFunctionCommand({ functionName: NAME }));
} catch (err) {
  if (!/NotFound/i.test(err.name)) throw err;
  exists = false;
}
if (!exists) {
  log(`creating web function ${NAME} with endpoint "${ENDPOINT}"…`);
  const res = await web.send(
    new CreateWebFunctionCommand({
      functionName: NAME,
      revisionConfig: { description: 'Glitchless intake + query API + dashboard', buildConfig, serviceConfig },
      endpointConfig: {
        endpointName: ENDPOINT,
        endpointType: 'HomeRegion',
        authType: 'ApplicationManaged', // public: browsers post telemetry here; the app checks tokens
        autoDeploymentMode: 'LatestRevision',
        throttleConfig: { rateLimit: 100 }, // req/s cap protects DynamoDB (and the bill) from a viral spike
        scalingConfig: { maxEnvironments: 5 },
      },
      tags: { app: 'glitchless' },
    }),
  );
  revisionId = res.revision?.revisionId;
} else {
  log(`creating new revision of ${NAME}…`);
  revisionId = (await web.send(new CreateWebFunctionRevisionCommand({ functionName: NAME, description: `deploy ${new Date().toISOString()}`, buildConfig, serviceConfig }))).revisionId;
}

for (let i = 0; i < 90; i++) {
  const r = await web.send(new GetWebFunctionRevisionCommand({ functionName: NAME, revisionId }));
  if (r.state === 'Active') break;
  if (r.state === 'Failed') throw new Error(`revision failed: ${r.stateReason} ${JSON.stringify(r.errors || [])}`);
  if (i % 5 === 0) log(`revision ${revisionId}: ${r.state}…`);
  await sleep(4000);
}
let endpoint;
for (let i = 0; i < 90; i++) {
  endpoint = await web.send(new GetWebFunctionEndpointCommand({ functionName: NAME, endpointName: ENDPOINT }));
  if (endpoint.state === 'Active') break;
  if (i % 5 === 0) log(`endpoint: ${endpoint.state}…`);
  await sleep(4000);
}
const url = `https://${endpoint.domainName}`;
Object.assign(state, { url, region: REGION, function: NAME, table: TABLE, bucket: BUCKET, role: ROLE, revisionId, deployedAt: new Date().toISOString() });
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// smoke test — Lambda doesn't check the server actually listens, so we do
await sleep(2000);
try {
  const h = await fetch(`${url}/v1/health`).then((r) => r.json());
  log(`health: ${JSON.stringify(h)}`);
} catch (err) {
  log(`health check failed (may still be warming up): ${err.message}`);
}
console.log(`\n🐶 Glitchless is live on Lambda Web Functions\n   dashboard  ${url}\n   game       ${url}/play/\n   read key   ${state.apiKey}   (dashboard + MCP: x-glitchless-api-key)\n   state      ${path.relative(ROOT, STATE_FILE)}\n`);
console.log(`   claude mcp add glitchless-aws -e GLITCHLESS_URL=${url} -e GLITCHLESS_API_KEY=${state.apiKey} -- node packages/mcp/src/index.js`);
