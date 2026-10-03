// Transport W3C uniquement ; aucune dépendance ni protocole WebKit privé.
export class WebDriverClient {
  constructor(origin, timeoutMs = 60_000) { this.origin = origin; this.session = null; this.timeoutMs = timeoutMs; }
  async request(method, path, body, timeout = this.timeoutMs) {
    let response;
    try { response = await fetch(this.origin + path, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    }); } catch (error) {
      throw new Error(`WebDriver ${method} ${path} (${timeout} ms) : ${error.message}`, { cause: error });
    }
    const { value } = await response.json();
    if (!response.ok || value?.error) throw new Error(`WebDriver ${path}: ${value?.error}: ${value?.message}`);
    return value;
  }
  command(method, path, body, timeout) { return this.request(method, `/session/${this.session}${path}`, body, timeout); }
  execute(fn, args = [], async = false, timeout) {
    return this.command('POST', `/execute/${async ? 'async' : 'sync'}`, {
      script: async
        ? `const done = arguments[arguments.length-1]; Promise.resolve((${fn})(...Array.from(arguments).slice(0,-1))).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error?.stack||error)}));`
        : `return (${fn})(...arguments);`, args,
    }, timeout);
  }
}
