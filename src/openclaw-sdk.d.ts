
declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    pluginConfig: any;
    logger: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
    resolvePath: (path: string) => string;
    registerTool: (def: any, opts?: any) => void;
    registerCli: (fn: (cli: { program: any }) => void) => void;
    registerService: (svc: { id: string; start: () => void; stop: () => void }) => void;
    on: (event: string, cb: (data: any, ctx: any) => void) => void;
    sendMessage?: (opts: any) => Promise<any>;
    runtime?: any;
  }
}
