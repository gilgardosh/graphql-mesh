/* eslint-disable dot-notation */
import { GraphQLSchema, execute, subscribe } from 'graphql';
import express, { RequestHandler } from 'express';
import { Logger } from 'winston';
import { fork as clusterFork, isMaster } from 'cluster';
import { cpus } from 'os';
import 'json-bigint-patch';
import { createServer as createHTTPServer, Server } from 'http';
import { playgroundMiddlewareFactory } from './playground';
import { graphqlUploadExpress } from 'graphql-upload';
import ws from 'ws';
import { MeshPubSub, YamlConfig } from '@graphql-mesh/types';
import cors from 'cors';
import { loadFromModuleExportExpression, pathExists } from '@graphql-mesh/utils';
import { get } from 'lodash';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { graphqlHandler } from './graphql-handler';

import { createServer as createHTTPSServer } from 'https';
import { promises as fsPromises } from 'fs';
import { loadDocuments } from '@graphql-tools/load';
import { CodeFileLoader } from '@graphql-tools/code-file-loader';
import { GraphQLFileLoader } from '@graphql-tools/graphql-file-loader';

const { readFile } = fsPromises;

export async function serveMesh(
  logger: Logger,
  schema: GraphQLSchema,
  contextBuilder: (initialContextValue?: any) => Promise<Record<string, any>>,
  pubsub: MeshPubSub,
  baseDir = process.cwd(),
  {
    fork,
    exampleQuery,
    port,
    hostname = 'localhost',
    cors: corsConfig,
    handlers,
    staticFiles,
    playground,
    upload: { maxFileSize = 10000000, maxFiles = 10 } = {},
    maxRequestBodySize = '100kb',
    sslCredentials,
  }: YamlConfig.ServeConfig = {}
): Promise<void> {
  const protocol = sslCredentials ? 'https' : 'http';
  const graphqlPath = '/graphql';
  const serverUrl = `${protocol}://${hostname}:${port}${graphqlPath}`;
  const { useServer }: typeof import('graphql-ws/lib/use/ws') = require('graphql-ws/lib/use/ws');
  if (isMaster && fork) {
    const forkNum = fork > 1 ? fork : cpus().length;
    for (let i = 0; i < forkNum; i++) {
      clusterFork();
    }
    logger.info(`🕸️ => Serving GraphQL Mesh: ${serverUrl} in ${forkNum} forks`);
  } else {
    const app = express();
    app.set('trust proxy', 'loopback');
    let httpServer: Server;

    if (sslCredentials) {
      const [key, cert] = await Promise.all([
        readFile(sslCredentials.key, 'utf-8'),
        readFile(sslCredentials.cert, 'utf-8'),
      ]);
      httpServer = createHTTPSServer({ key, cert }, app);
    } else {
      httpServer = createHTTPServer(app);
    }

    if (corsConfig) {
      app.use(cors(corsConfig));
    }

    app.use(
      bodyParser.json({
        limit: maxRequestBodySize,
      })
    );
    app.use(cookieParser());

    if (staticFiles) {
      app.use(express.static(staticFiles));
      const indexPath = join(baseDir, staticFiles, 'index.html');
      if (await pathExists(indexPath)) {
        app.get('/', (_req, res) => res.sendFile(indexPath));
      }
    }

    app.use(graphqlPath, graphqlUploadExpress({ maxFileSize, maxFiles }), graphqlHandler(schema, contextBuilder));

    const wsServer = new ws.Server({
      path: graphqlPath,
      server: httpServer,
    });

    useServer(
      {
        schema,
        execute,
        subscribe,
        context: ctx => contextBuilder(ctx.extra.request),
      },
      wsServer
    );

    const pubSubHandler: RequestHandler = (req, _res, next) => {
      req['pubsub'] = pubsub;
      next();
    };
    app.use(pubSubHandler);

    const registeredPaths = new Set<string>();
    await Promise.all(
      handlers?.map(async handlerConfig => {
        registeredPaths.add(handlerConfig.path);
        if ('handler' in handlerConfig) {
          const handlerFn = await loadFromModuleExportExpression<RequestHandler>(handlerConfig.handler);
          app[handlerConfig.method.toLowerCase() || 'use'](handlerConfig.path, handlerFn);
        } else if ('pubsubTopic' in handlerConfig) {
          app.use(handlerConfig.path, (req, res) => {
            let payload = req.body;
            if (handlerConfig.payload) {
              payload = get(payload, handlerConfig.payload);
            }
            pubsub.publish(handlerConfig.pubsubTopic, payload);
            res.end();
          });
        }
      }) || []
    );

    if (typeof playground !== 'undefined' ? playground : process.env.NODE_ENV?.toLowerCase() !== 'production') {
      let defaultQuery: string;
      if (exampleQuery) {
        const documents = await loadDocuments(exampleQuery, {
          loaders: [new CodeFileLoader(), new GraphQLFileLoader()],
          cwd: baseDir,
        });

        defaultQuery = documents.reduce((acc, doc) => (acc += doc.rawSDL! + '\n'), '');
      }
      const playgroundMiddleware = playgroundMiddlewareFactory({ defaultQuery, graphqlPath });
      if (!staticFiles) {
        app.get('/', playgroundMiddleware);
      }
      app.get(graphqlPath, playgroundMiddleware);
      app.use(express.static(join(__dirname, './public')));
    }

    httpServer
      .listen(parseInt(port.toString()), hostname, () => {
        if (!fork) {
          logger.info(`🕸️ => Serving GraphQL Mesh: ${serverUrl}`);
        }
      })
      .on('error', e => {
        logger.error(`Unable to start GraphQL-Mesh: ${e.message}`);
      });
  }
}
