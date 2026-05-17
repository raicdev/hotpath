import {
  CServer,
  compiled,
  cors,
  header,
  headers,
  html,
  json,
  jsonTemplate,
  native,
  reply,
  requireHeader,
  template,
  text,
  type CHandler,
  type CMiddleware,
  type CNativeContext,
  type CNativeValue,
  type CReply,
  type CRouteOptions,
  type CServerOptions
} from "./c";
import type { HotpathAdapterObject } from "./index";

export type NativeAdapterOptions = CServerOptions;

export function nativeAdapter(options: NativeAdapterOptions = {}): HotpathAdapterObject<CServer> {
  return {
    kind: "hotpath-adapter",
    name: "native",
    create: () => new CServer(options)
  };
}

export {
  CServer,
  compiled,
  cors,
  header,
  headers,
  html,
  json,
  jsonTemplate,
  native,
  reply,
  requireHeader,
  template,
  text
};

export type {
  CHandler,
  CMiddleware,
  CNativeContext,
  CNativeValue,
  CReply,
  CRouteOptions,
  CServerOptions
};
