use memchr::memmem;
use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Deserialize)]
struct Config {
    routes: Vec<ConfigRoute>,
}

#[derive(Debug, Deserialize)]
struct ConfigRoute {
    method: String,
    path: String,
    status: Option<u16>,
    headers: Option<HashMap<String, String>>,
    body: String,
}

#[derive(Clone)]
struct App {
    exact: HashMap<String, Route>,
    dynamic: Vec<Route>,
}

#[derive(Clone)]
struct Route {
    method: String,
    path: String,
    parts: Vec<RoutePart>,
    response: ResponseSpec,
    prebuilt: Option<Arc<Vec<u8>>>,
}

#[derive(Clone)]
enum RoutePart {
    Static(String),
    Param(String),
}

#[derive(Clone)]
struct ResponseSpec {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
    template: Vec<BodyPart>,
}

#[derive(Clone)]
enum BodyPart {
    Static(Vec<u8>),
    Param(String),
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> io::Result<()> {
    let args = Args::parse()?;
    let config = fs::read_to_string(&args.config)?;
    let config: Config = serde_json::from_str(&config)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
    let app = Arc::new(App::compile(config));
    let listener = TcpListener::bind((args.host.as_str(), args.port)).await?;

    println!("hotpath-rust listening on http://{}:{}", args.host, args.port);

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let app = Arc::clone(&app);
                tokio::spawn(async move {
                    let _ = serve_connection(stream, app).await;
                });
            }
            _ = tokio::signal::ctrl_c() => {
                break;
            }
        }
    }

    Ok(())
}

struct Args {
    host: String,
    port: u16,
    config: String,
}

impl Args {
    fn parse() -> io::Result<Self> {
        let mut host = "0.0.0.0".to_string();
        let mut port = 3000;
        let mut config = None;
        let mut args = env::args().skip(1);

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--host" => host = required_value(&mut args, "--host")?,
                "--port" => {
                    port = required_value(&mut args, "--port")?.parse().map_err(|err| {
                        io::Error::new(io::ErrorKind::InvalidInput, format!("invalid --port: {err}"))
                    })?;
                }
                "--config" => config = Some(required_value(&mut args, "--config")?),
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("unknown argument: {arg}"),
                    ));
                }
            }
        }

        let config = config.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "--config is required")
        })?;

        Ok(Self { host, port, config })
    }
}

fn required_value(args: &mut impl Iterator<Item = String>, name: &str) -> io::Result<String> {
    args.next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("{name} needs a value")))
}

impl App {
    fn compile(config: Config) -> Self {
        let mut exact = HashMap::new();
        let mut dynamic = Vec::new();

        for route in config.routes {
            let compiled = Route::compile(route);
            if compiled.parts.iter().any(|part| matches!(part, RoutePart::Param(_))) {
                dynamic.push(compiled);
            } else {
                exact.insert(route_key(&compiled.method, &compiled.path), compiled);
            }
        }

        Self { exact, dynamic }
    }

    fn find<'a, 'p>(&'a self, method: &str, path: &'p str) -> Match<'a, 'p> {
        if let Some(route) = self.exact.get(&route_key(method, path)) {
            return Match::Found(route, Vec::new());
        }

        let path_parts = split_path_view(path);
        let mut method_mismatch = false;

        for route in &self.dynamic {
            if route.parts.len() != path_parts.len() {
                continue;
            }

            let mut params = Vec::new();
            let mut matches_path = true;

            for (route_part, path_part) in route.parts.iter().zip(path_parts.iter()) {
                match route_part {
                    RoutePart::Static(value) if value.as_str() == *path_part => {}
                    RoutePart::Static(_) => {
                        matches_path = false;
                        break;
                    }
                    RoutePart::Param(name) => {
                        params.push((name.as_str(), *path_part));
                    }
                }
            }

            if !matches_path {
                continue;
            }

            if route.method == method {
                return Match::Found(route, params);
            }

            method_mismatch = true;
        }

        if method_mismatch || self.path_exists(path) {
            Match::MethodNotAllowed
        } else {
            Match::NotFound
        }
    }

    fn path_exists(&self, path: &str) -> bool {
        if self
            .exact
            .values()
            .any(|route| route.path.as_str() == path)
        {
            return true;
        }

        false
    }
}

enum Match<'a, 'p> {
    Found(&'a Route, Vec<(&'a str, &'p str)>),
    MethodNotAllowed,
    NotFound,
}

impl Route {
    fn compile(route: ConfigRoute) -> Self {
        let status = route.status.unwrap_or(200);
        let headers: Vec<(String, String)> = route
            .headers
            .unwrap_or_default()
            .into_iter()
            .collect();
        let response = ResponseSpec {
            status,
            headers,
            template: compile_template(&route.body),
            body: route.body,
        };
        let parts = split_path(&route.path)
            .into_iter()
            .map(|part| {
                if let Some(name) = part.strip_prefix(':') {
                    RoutePart::Param(name.to_string())
                } else {
                    RoutePart::Static(part)
                }
            })
            .collect::<Vec<_>>();
        let prebuilt = if parts.iter().all(|part| matches!(part, RoutePart::Static(_))) {
            Some(Arc::new(build_response(
                response.status,
                &response.headers,
                response.body.as_bytes(),
            )))
        } else {
            None
        };

        Self {
            method: route.method,
            path: route.path,
            parts,
            response,
            prebuilt,
        }
    }
}

async fn serve_connection(mut stream: TcpStream, app: Arc<App>) -> io::Result<()> {
    let mut buf = Vec::with_capacity(16 * 1024);
    let mut chunk = [0_u8; 16 * 1024];

    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }

        buf.extend_from_slice(&chunk[..read]);

        while let Some(header_end) = find_header_end(&buf) {
            let request = &buf[..header_end];
            let close = has_connection_close(request);
            let response = match parse_request_line(request) {
                Some((method, target)) => {
                    let path = path_only(target);
                    app.respond(method, path)
                }
                None => build_response(400, &[], b"Bad Request"),
            };

            stream.write_all(&response).await?;
            buf.drain(..header_end + 4);

            if close {
                return Ok(());
            }
        }

        if buf.len() > 1024 * 1024 {
            stream
                .write_all(&build_response(431, &[], b"Request Header Fields Too Large"))
                .await?;
            return Ok(());
        }
    }
}

impl App {
    fn respond(&self, method: &str, path: &str) -> Vec<u8> {
        match self.find(method, path) {
            Match::Found(route, params) => {
                if let Some(prebuilt) = &route.prebuilt {
                    return prebuilt.as_ref().clone();
                }

                let body = render_template(&route.response.template, &params);
                build_response(
                    route.response.status,
                    &route.response.headers,
                    &body,
                )
            }
            Match::MethodNotAllowed => build_response(405, &[], b"Method Not Allowed"),
            Match::NotFound => build_response(404, &[], b"Not Found"),
        }
    }
}

fn parse_request_line(request: &[u8]) -> Option<(&str, &str)> {
    let line_end = memmem::find(request, b"\r\n")?;
    let line = std::str::from_utf8(&request[..line_end]).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    Some((method, target))
}

fn has_connection_close(request: &[u8]) -> bool {
    request
        .windows("connection: close".len())
        .any(|window| window.eq_ignore_ascii_case(b"connection: close"))
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    memmem::find(buf, b"\r\n\r\n")
}

fn path_only(target: &str) -> &str {
    target.split_once('?').map_or(target, |(path, _)| path)
}

fn split_path(path: &str) -> Vec<String> {
    if path == "/" {
        Vec::new()
    } else {
        path.trim_start_matches('/')
            .split('/')
            .map(ToString::to_string)
            .collect()
    }
}

fn split_path_view(path: &str) -> Vec<&str> {
    if path == "/" {
        Vec::new()
    } else {
        path.trim_start_matches('/').split('/').collect()
    }
}

fn route_key(method: &str, path: &str) -> String {
    let mut key = String::with_capacity(method.len() + 1 + path.len());
    key.push_str(method);
    key.push(' ');
    key.push_str(path);
    key
}

fn compile_template(template: &str) -> Vec<BodyPart> {
    let bytes = template.as_bytes();
    let mut parts = Vec::new();
    let mut cursor = 0;

    while let Some(open_offset) = bytes[cursor..].iter().position(|byte| *byte == b'{') {
        let open = cursor + open_offset;
        let Some(close_offset) = bytes[open + 1..].iter().position(|byte| *byte == b'}') else {
            break;
        };
        let close = open + 1 + close_offset;

        if open > cursor {
            parts.push(BodyPart::Static(bytes[cursor..open].to_vec()));
        }

        parts.push(BodyPart::Param(template[open + 1..close].to_string()));
        cursor = close + 1;
    }

    if cursor < bytes.len() {
        parts.push(BodyPart::Static(bytes[cursor..].to_vec()));
    }

    parts
}

fn render_template(template: &[BodyPart], params: &[(&str, &str)]) -> Vec<u8> {
    let mut body = Vec::with_capacity(64);

    for part in template {
        match part {
            BodyPart::Static(value) => body.extend_from_slice(value),
            BodyPart::Param(name) => {
                if let Some((_, value)) = params.iter().find(|(key, _)| *key == name) {
                    body.extend_from_slice(value.as_bytes());
                }
            }
        }
    }

    body
}

fn build_response(status: u16, headers: &[(String, String)], body: &[u8]) -> Vec<u8> {
    let reason = reason_phrase(status);
    let mut response = Vec::with_capacity(128 + body.len());
    response.extend_from_slice(b"HTTP/1.1 ");
    response.extend_from_slice(status.to_string().as_bytes());
    response.push(b' ');
    response.extend_from_slice(reason.as_bytes());
    response.extend_from_slice(b"\r\nContent-Length: ");
    response.extend_from_slice(body.len().to_string().as_bytes());
    response.extend_from_slice(b"\r\n");

    for (name, value) in headers {
        response.extend_from_slice(name.as_bytes());
        response.extend_from_slice(b": ");
        response.extend_from_slice(value.as_bytes());
        response.extend_from_slice(b"\r\n");
    }

    response.extend_from_slice(b"\r\n");
    response.extend_from_slice(body);
    response
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    }
}
