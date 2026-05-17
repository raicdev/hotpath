#define _GNU_SOURCE

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define MAX_EVENTS 4096
#define MAX_ROUTES 256
#define MAX_PARTS 32
#define MAX_PARAMS 16
#define MAX_MIDDLEWARE 64
#define MAX_ROUTE_MIDDLEWARE 16
#define BUF_SIZE 8192
#define RESPONSE_SIZE 4096

typedef enum {
  MW_HEADER = 1,
  MW_REQUIRE_HEADER = 2
} middleware_kind_t;

typedef enum {
  METHOD_UNKNOWN = 0,
  METHOD_GET,
  METHOD_POST,
  METHOD_PUT,
  METHOD_PATCH,
  METHOD_DELETE,
  METHOD_OPTIONS,
  METHOD_HEAD
} method_code_t;

typedef struct {
  middleware_kind_t kind;
  char name[64];
  size_t name_len;
  char value[256];
  size_t value_len;
} middleware_t;

typedef struct {
  int enabled;
  char origin[128];
  char methods[128];
  char headers[256];
  int credentials;
  char max_age[32];
} cors_config_t;

typedef struct {
  int is_param;
  char text[128];
  size_t len;
} route_part_t;

typedef struct {
  char method[8];
  method_code_t method_code;
  char path[256];
  int status;
  int proxy;
  int proxy_tcp;
  int proxy_unix;
  int proxy_port;
  int handler_index;
  char proxy_socket[108];
  char content_type[128];
  char body[1024];
  route_part_t parts[MAX_PARTS];
  int part_count;
  int dynamic;
  int simple_template;
  int template_param_index;
  char template_prefix[512];
  size_t template_prefix_len;
  char template_suffix[512];
  size_t template_suffix_len;
  middleware_t middleware[MAX_ROUTE_MIDDLEWARE];
  int middleware_count;
  char prebuilt[RESPONSE_SIZE];
  size_t prebuilt_len;
} route_t;

typedef struct {
  const char *name;
  size_t name_len;
  const char *value;
  size_t value_len;
} param_t;

typedef struct {
  int fd;
  int wants_write;
  size_t len;
  size_t out_len;
  size_t out_sent;
  char buf[BUF_SIZE];
  char out[RESPONSE_SIZE];
} conn_t;

typedef struct {
  const char *host;
  int port;
  int worker_id;
} worker_arg_t;

static route_t routes[MAX_ROUTES];
static int route_count = 0;
static middleware_t global_middleware[MAX_MIDDLEWARE];
static int global_middleware_count = 0;
static cors_config_t cors_config = {0};
static char response_not_found[RESPONSE_SIZE];
static size_t response_not_found_len = 0;
static char response_method_not_allowed[RESPONSE_SIZE];
static size_t response_method_not_allowed_len = 0;
static char response_unauthorized[RESPONSE_SIZE];
static size_t response_unauthorized_len = 0;
static char response_bad_request[RESPONSE_SIZE];
static size_t response_bad_request_len = 0;
static char response_bad_gateway[RESPONSE_SIZE];
static size_t response_bad_gateway_len = 0;
static char response_options[RESPONSE_SIZE];
static size_t response_options_len = 0;

static size_t content_length(char *buf, size_t len);
static char *find_header_end(char *buf, size_t len);

static __thread int proxy_fd = -1;
static __thread int proxy_fd_port = 0;
static __thread char proxy_fd_socket[108] = {0};

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static method_code_t parse_method_code(const char *method, size_t len) {
  switch (len) {
    case 3:
      if (memcmp(method, "GET", 3) == 0) return METHOD_GET;
      if (memcmp(method, "PUT", 3) == 0) return METHOD_PUT;
      break;
    case 4:
      if (memcmp(method, "POST", 4) == 0) return METHOD_POST;
      if (memcmp(method, "HEAD", 4) == 0) return METHOD_HEAD;
      break;
    case 5:
      if (memcmp(method, "PATCH", 5) == 0) return METHOD_PATCH;
      break;
    case 6:
      if (memcmp(method, "DELETE", 6) == 0) return METHOD_DELETE;
      break;
    case 7:
      if (memcmp(method, "OPTIONS", 7) == 0) return METHOD_OPTIONS;
      break;
  }

  return METHOD_UNKNOWN;
}

static const char *reason_phrase(int status) {
  switch (status) {
    case 200: return "OK";
    case 201: return "Created";
    case 204: return "No Content";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 431: return "Request Header Fields Too Large";
    case 500: return "Internal Server Error";
    case 502: return "Bad Gateway";
    default: return "OK";
  }
}

static size_t append_bytes(char *out, size_t cap, size_t written, const char *data, size_t len) {
  if (written >= cap) return written;
  if (written + len > cap) len = cap - written;
  memcpy(out + written, data, len);
  return written + len;
}

static size_t append_cstr(char *out, size_t cap, size_t written, const char *data) {
  return append_bytes(out, cap, written, data, strlen(data));
}

static size_t append_header_line(
  char *out,
  size_t cap,
  size_t written,
  const char *name,
  const char *value
) {
  written = append_cstr(out, cap, written, name);
  written = append_cstr(out, cap, written, ": ");
  written = append_cstr(out, cap, written, value);
  return append_cstr(out, cap, written, "\r\n");
}

static size_t append_middleware_headers(
  char *out,
  size_t cap,
  size_t written,
  const middleware_t *route_middleware,
  int route_middleware_count
) {
  if (cors_config.enabled) {
    written = append_header_line(out, cap, written, "access-control-allow-origin", cors_config.origin);
    written = append_header_line(out, cap, written, "access-control-allow-methods", cors_config.methods);
    if (cors_config.headers[0]) {
      written = append_header_line(out, cap, written, "access-control-allow-headers", cors_config.headers);
    }
    if (cors_config.credentials) {
      written = append_header_line(out, cap, written, "access-control-allow-credentials", "true");
    }
    if (cors_config.max_age[0]) {
      written = append_header_line(out, cap, written, "access-control-max-age", cors_config.max_age);
    }
  }

  for (int i = 0; i < global_middleware_count; i++) {
    const middleware_t *mw = &global_middleware[i];
    if (mw->kind == MW_HEADER) {
      written = append_header_line(out, cap, written, mw->name, mw->value);
    }
  }

  for (int i = 0; i < route_middleware_count; i++) {
    const middleware_t *mw = &route_middleware[i];
    if (mw->kind == MW_HEADER) {
      written = append_header_line(out, cap, written, mw->name, mw->value);
    }
  }

  return written;
}

static size_t build_response_with_middleware(
  char *out,
  size_t cap,
  int status,
  const char *content_type,
  const char *body,
  size_t body_len,
  const middleware_t *route_middleware,
  int route_middleware_count
) {
  int n = snprintf(
    out,
    cap,
    "HTTP/1.1 %d %s\r\nContent-Length: %zu\r\n%s%s%s",
    status,
    reason_phrase(status),
    body_len,
    content_type && content_type[0] ? "content-type: " : "",
    content_type && content_type[0] ? content_type : "",
    content_type && content_type[0] ? "\r\n" : ""
  );
  if (n < 0) return 0;

  size_t head_len = (size_t)n;
  if (head_len > cap) head_len = cap;
  head_len = append_middleware_headers(out, cap, head_len, route_middleware, route_middleware_count);
  head_len = append_cstr(out, cap, head_len, "\r\n");

  if (head_len + body_len > cap) body_len = cap > head_len ? cap - head_len : 0;
  memcpy(out + head_len, body, body_len);
  return head_len + body_len;
}

static size_t build_response(
  char *out,
  size_t cap,
  int status,
  const char *content_type,
  const char *body,
  size_t body_len
) {
  return build_response_with_middleware(out, cap, status, content_type, body, body_len, NULL, 0);
}

static void compile_path(route_t *route) {
  char tmp[sizeof(route->path)];
  strncpy(tmp, route->path, sizeof(tmp) - 1);
  tmp[sizeof(tmp) - 1] = '\0';

  route->part_count = 0;
  route->dynamic = 0;

  if (strcmp(tmp, "/") == 0) return;

  char *cursor = tmp[0] == '/' ? tmp + 1 : tmp;
  char *save = NULL;
  char *part = strtok_r(cursor, "/", &save);

  while (part && route->part_count < MAX_PARTS) {
    route_part_t *compiled = &route->parts[route->part_count++];
    if (part[0] == ':') {
      compiled->is_param = 1;
      route->dynamic = 1;
      strncpy(compiled->text, part + 1, sizeof(compiled->text) - 1);
    } else {
      compiled->is_param = 0;
      strncpy(compiled->text, part, sizeof(compiled->text) - 1);
    }
    compiled->text[sizeof(compiled->text) - 1] = '\0';
    compiled->len = strlen(compiled->text);
    part = strtok_r(NULL, "/", &save);
  }
}

static int is_template_name_char(char c) {
  return isalnum((unsigned char)c) || c == '_' || c == '-';
}

static const char *find_template_open(const char *cursor, const char **close_out) {
  while ((cursor = strchr(cursor, '{'))) {
    const char *close = strchr(cursor + 1, '}');
    if (!close) return NULL;
    if (close == cursor + 1) {
      cursor++;
      continue;
    }

    int valid = 1;
    for (const char *name = cursor + 1; name < close; name++) {
      if (!is_template_name_char(*name)) {
        valid = 0;
        break;
      }
    }

    if (valid) {
      *close_out = close;
      return cursor;
    }

    cursor++;
  }

  return NULL;
}

static void compile_template(route_t *route) {
  route->simple_template = 0;
  route->template_param_index = -1;

  const char *close = NULL;
  const char *open = find_template_open(route->body, &close);
  if (!open) return;

  const char *next_close = NULL;
  if (find_template_open(close + 1, &next_close)) return;

  size_t name_len = (size_t)(close - open - 1);
  int param_index = 0;
  int matched_param_index = -1;

  for (int i = 0; i < route->part_count; i++) {
    if (!route->parts[i].is_param) continue;
    if (route->parts[i].len == name_len && memcmp(route->parts[i].text, open + 1, name_len) == 0) {
      matched_param_index = param_index;
      break;
    }
    param_index++;
  }

  if (matched_param_index < 0) return;

  size_t prefix_len = (size_t)(open - route->body);
  size_t suffix_len = strlen(close + 1);
  if (prefix_len >= sizeof(route->template_prefix) || suffix_len >= sizeof(route->template_suffix)) return;

  memcpy(route->template_prefix, route->body, prefix_len);
  route->template_prefix[prefix_len] = '\0';
  memcpy(route->template_suffix, close + 1, suffix_len);
  route->template_suffix[suffix_len] = '\0';
  route->template_prefix_len = prefix_len;
  route->template_suffix_len = suffix_len;
  route->template_param_index = matched_param_index;
  route->simple_template = 1;
}

static void prebuild_routes(void) {
  for (int i = 0; i < route_count; i++) {
    route_t *route = &routes[i];
    if (route->proxy) continue;
    if (route->dynamic) continue;

    route->prebuilt_len = build_response_with_middleware(
      route->prebuilt,
      sizeof(route->prebuilt),
      route->status,
      route->content_type,
      route->body,
      strlen(route->body),
      route->middleware,
      route->middleware_count
    );
  }
}

static void prebuild_standard_responses(void) {
  response_not_found_len = build_response(
    response_not_found,
    sizeof(response_not_found),
    404,
    "",
    "Not Found",
    9
  );
  response_method_not_allowed_len = build_response(
    response_method_not_allowed,
    sizeof(response_method_not_allowed),
    405,
    "",
    "Method Not Allowed",
    18
  );
  response_unauthorized_len = build_response(
    response_unauthorized,
    sizeof(response_unauthorized),
    401,
    "",
    "Unauthorized",
    12
  );
  response_bad_request_len = build_response(
    response_bad_request,
    sizeof(response_bad_request),
    400,
    "",
    "Bad Request",
    11
  );
  response_bad_gateway_len = build_response(
    response_bad_gateway,
    sizeof(response_bad_gateway),
    502,
    "",
    "Bad Gateway",
    11
  );
  response_options_len = build_response(response_options, sizeof(response_options), 204, "", "", 0);
}

static int add_middleware(middleware_t *items, int *count, int max, middleware_kind_t kind, const char *name, const char *value) {
  if (*count >= max || !name || !value) return -1;

  middleware_t *mw = &items[(*count)++];
  memset(mw, 0, sizeof(*mw));
  mw->kind = kind;
  strncpy(mw->name, name, sizeof(mw->name) - 1);
  strncpy(mw->value, value, sizeof(mw->value) - 1);
  mw->name_len = strlen(mw->name);
  mw->value_len = strlen(mw->value);
  return 0;
}

static int split_tabs(char *line, char *fields[], int max_fields) {
  int count = 0;
  char *cursor = line;

  while (count < max_fields) {
    fields[count++] = cursor;
    char *tab = strchr(cursor, '\t');
    if (!tab) break;
    *tab = '\0';
    cursor = tab + 1;
  }

  return count;
}

static void add_route_from_fields(char *fields[], int offset, int count) {
  if (route_count >= MAX_ROUTES || count < offset + 5) return;

  route_t *route = &routes[route_count++];
  memset(route, 0, sizeof(*route));
  strncpy(route->method, fields[offset], sizeof(route->method) - 1);
  route->method_code = parse_method_code(route->method, strlen(route->method));
  strncpy(route->path, fields[offset + 1], sizeof(route->path) - 1);
  route->status = atoi(fields[offset + 2]);
  strncpy(route->content_type, fields[offset + 3], sizeof(route->content_type) - 1);
  strncpy(route->body, fields[offset + 4], sizeof(route->body) - 1);
  compile_path(route);
  compile_template(route);
}

static void add_proxy_route_from_fields(char *fields[], int count) {
  if (route_count >= MAX_ROUTES || count < 4) return;

  route_t *route = &routes[route_count++];
  memset(route, 0, sizeof(*route));
  route->proxy = 1;
  route->handler_index = -1;
  strncpy(route->method, fields[1], sizeof(route->method) - 1);
  route->method_code = parse_method_code(route->method, strlen(route->method));
  strncpy(route->path, fields[2], sizeof(route->path) - 1);
  route->proxy_port = atoi(fields[3]);
  compile_path(route);
}

static void add_proxy_tcp_route_from_fields(char *fields[], int count) {
  if (route_count >= MAX_ROUTES || count < 4) return;

  route_t *route = &routes[route_count++];
  memset(route, 0, sizeof(*route));
  route->proxy = 1;
  route->proxy_tcp = 1;
  route->handler_index = count >= 5 ? atoi(fields[4]) : -1;
  strncpy(route->method, fields[1], sizeof(route->method) - 1);
  route->method_code = parse_method_code(route->method, strlen(route->method));
  strncpy(route->path, fields[2], sizeof(route->path) - 1);
  route->proxy_port = atoi(fields[3]);
  compile_path(route);
}

static void add_proxy_unix_route_from_fields(char *fields[], int count) {
  if (route_count >= MAX_ROUTES || count < 5) return;

  route_t *route = &routes[route_count++];
  memset(route, 0, sizeof(*route));
  route->proxy = 1;
  route->proxy_tcp = 1;
  route->proxy_unix = 1;
  route->handler_index = atoi(fields[4]);
  strncpy(route->method, fields[1], sizeof(route->method) - 1);
  route->method_code = parse_method_code(route->method, strlen(route->method));
  strncpy(route->path, fields[2], sizeof(route->path) - 1);
  strncpy(route->proxy_socket, fields[3], sizeof(route->proxy_socket) - 1);
  compile_path(route);
}

static void add_global_middleware_from_fields(char *fields[], int count) {
  if (count < 2) return;

  if (strcmp(fields[1], "HEADER") == 0 && count >= 4) {
    add_middleware(global_middleware, &global_middleware_count, MAX_MIDDLEWARE, MW_HEADER, fields[2], fields[3]);
  } else if (strcmp(fields[1], "REQUIRE_HEADER") == 0 && count >= 4) {
    add_middleware(global_middleware, &global_middleware_count, MAX_MIDDLEWARE, MW_REQUIRE_HEADER, fields[2], fields[3]);
  } else if (strcmp(fields[1], "CORS") == 0 && count >= 3) {
    cors_config.enabled = 1;
    strncpy(cors_config.origin, fields[2][0] ? fields[2] : "*", sizeof(cors_config.origin) - 1);
    strncpy(
      cors_config.methods,
      count >= 4 && fields[3][0] ? fields[3] : "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      sizeof(cors_config.methods) - 1
    );
    if (count >= 5) strncpy(cors_config.headers, fields[4], sizeof(cors_config.headers) - 1);
    cors_config.credentials = count >= 6 && strcmp(fields[5], "1") == 0;
    if (count >= 7) strncpy(cors_config.max_age, fields[6], sizeof(cors_config.max_age) - 1);
  }
}

static void add_route_middleware_from_fields(char *fields[], int count) {
  if (count < 5) return;

  int route_index = atoi(fields[1]);
  if (route_index < 0 || route_index >= route_count) return;

  route_t *route = &routes[route_index];
  if (strcmp(fields[2], "HEADER") == 0) {
    add_middleware(route->middleware, &route->middleware_count, MAX_ROUTE_MIDDLEWARE, MW_HEADER, fields[3], fields[4]);
  } else if (strcmp(fields[2], "REQUIRE_HEADER") == 0) {
    add_middleware(route->middleware, &route->middleware_count, MAX_ROUTE_MIDDLEWARE, MW_REQUIRE_HEADER, fields[3], fields[4]);
  }
}

static int load_routes(const char *config_path) {
  FILE *file = fopen(config_path, "r");
  if (!file) {
    perror("fopen config");
    return -1;
  }

  char *line = NULL;
  size_t cap = 0;

  while (getline(&line, &cap, file) != -1) {
    line[strcspn(line, "\r\n")] = '\0';
    if (line[0] == '\0' || line[0] == '#') continue;

    char *fields[16] = {0};
    int field_count = split_tabs(line, fields, 16);
    if (field_count == 0) continue;

    if (strcmp(fields[0], "MIDDLEWARE") == 0) {
      add_global_middleware_from_fields(fields, field_count);
    } else if (strcmp(fields[0], "ROUTE_MIDDLEWARE") == 0) {
      add_route_middleware_from_fields(fields, field_count);
    } else if (strcmp(fields[0], "ROUTE") == 0) {
      add_route_from_fields(fields, 1, field_count);
    } else if (strcmp(fields[0], "PROXY") == 0) {
      add_proxy_route_from_fields(fields, field_count);
    } else if (strcmp(fields[0], "PROXY_TCP") == 0) {
      add_proxy_tcp_route_from_fields(fields, field_count);
    } else if (strcmp(fields[0], "PROXY_UNIX") == 0) {
      add_proxy_unix_route_from_fields(fields, field_count);
    } else {
      add_route_from_fields(fields, 0, field_count);
    }
  }

  prebuild_standard_responses();
  prebuild_routes();
  free(line);
  fclose(file);
  return 0;
}

static int route_matches_path(const route_t *route, const char *path, param_t params[MAX_PARAMS], int *param_count) {
  const char *cursor = path;
  int part_index = 0;
  *param_count = 0;

  if (*cursor == '/') cursor++;

  if (*cursor == '\0') {
    return route->part_count == 0;
  }

  while (*cursor != '\0') {
    if (part_index >= route->part_count) return 0;

    const char *segment = cursor;
    while (*cursor != '\0' && *cursor != '/') cursor++;
    size_t segment_len = (size_t)(cursor - segment);

    const route_part_t *route_part = &route->parts[part_index++];
    if (route_part->is_param) {
      if (*param_count < MAX_PARAMS) {
        params[*param_count].name = route_part->text;
        params[*param_count].name_len = route_part->len;
        params[*param_count].value = segment;
        params[*param_count].value_len = segment_len;
        (*param_count)++;
      }
    } else if (route_part->len != segment_len || memcmp(route_part->text, segment, segment_len) != 0) {
      return 0;
    }

    if (*cursor == '/') cursor++;
  }

  return part_index == route->part_count;
}

static param_t *find_param(param_t params[MAX_PARAMS], int param_count, const char *name, size_t name_len) {
  for (int i = 0; i < param_count; i++) {
    if (params[i].name_len == name_len && memcmp(params[i].name, name, name_len) == 0) {
      return &params[i];
    }
  }
  return NULL;
}

static size_t render_body(const route_t *route, param_t params[MAX_PARAMS], int param_count, char *out, size_t cap) {
  if (route->simple_template && route->template_param_index >= 0 && route->template_param_index < param_count) {
    const param_t *param = &params[route->template_param_index];
    size_t written = 0;

    written = append_bytes(out, cap, written, route->template_prefix, route->template_prefix_len);
    written = append_bytes(out, cap, written, param->value, param->value_len);
    written = append_bytes(out, cap, written, route->template_suffix, route->template_suffix_len);
    return written;
  }

  size_t written = 0;
  const char *cursor = route->body;

  while (*cursor && written < cap) {
    const char *close = NULL;
    const char *open = find_template_open(cursor, &close);
    if (!open) {
      size_t len = strlen(cursor);
      if (written + len > cap) len = cap - written;
      memcpy(out + written, cursor, len);
      return written + len;
    }

    size_t prefix_len = (size_t)(open - cursor);
    if (written + prefix_len > cap) prefix_len = cap - written;
    memcpy(out + written, cursor, prefix_len);
    written += prefix_len;

    param_t *param = find_param(params, param_count, open + 1, (size_t)(close - open - 1));
    if (param) {
      size_t value_len = param->value_len;
      if (written + value_len > cap) value_len = cap - written;
      memcpy(out + written, param->value, value_len);
      written += value_len;
    }
    cursor = close + 1;
  }

  return written;
}

static int find_route(method_code_t method_code, const char *path, param_t params[MAX_PARAMS], int *param_count, int *method_mismatch) {
  *method_mismatch = 0;

  for (int i = 0; i < route_count; i++) {
    route_t *route = &routes[i];
    if (!route->dynamic && strcmp(route->path, path) == 0) {
      if (route->method_code == method_code) return i;
      *method_mismatch = 1;
    }
  }

  for (int i = 0; i < route_count; i++) {
    route_t *route = &routes[i];
    int local_param_count = 0;
    if (!route->dynamic) continue;
    if (!route_matches_path(route, path, params, &local_param_count)) continue;
    if (route->method_code == method_code) {
      *param_count = local_param_count;
      return i;
    }
    *method_mismatch = 1;
  }

  return -1;
}

static int header_value_matches(
  const char *request,
  size_t request_len,
  const char *name,
  size_t name_len,
  const char *expected,
  size_t expected_len
) {
  const char *line = memmem(request, request_len, "\r\n", 2);
  if (!line) return 0;
  line += 2;

  while ((size_t)(line - request) < request_len) {
    const char *line_end = memmem(line, request_len - (size_t)(line - request), "\r\n", 2);
    if (!line_end || line_end == line) break;

    const char *colon = memchr(line, ':', (size_t)(line_end - line));
    if (colon) {
      size_t current_name_len = (size_t)(colon - line);
      if (current_name_len == name_len && strncasecmp(line, name, name_len) == 0) {
        const char *value = colon + 1;
        while (value < line_end && (*value == ' ' || *value == '\t')) value++;
        while (line_end > value && (line_end[-1] == ' ' || line_end[-1] == '\t')) line_end--;
        return (size_t)(line_end - value) == expected_len && memcmp(value, expected, expected_len) == 0;
      }
    }

    line = line_end + 2;
  }

  return 0;
}

static int middleware_allows_request(
  const middleware_t *items,
  int count,
  const char *request,
  size_t request_len
) {
  for (int i = 0; i < count; i++) {
    const middleware_t *mw = &items[i];
    if (mw->kind != MW_REQUIRE_HEADER) continue;
    if (!header_value_matches(request, request_len, mw->name, mw->name_len, mw->value, mw->value_len)) return 0;
  }

  return 1;
}

static void close_proxy_fd(void) {
  if (proxy_fd >= 0) {
    close(proxy_fd);
    proxy_fd = -1;
    proxy_fd_port = 0;
    proxy_fd_socket[0] = '\0';
  }
}

static int connect_proxy(int port) {
  if (proxy_fd >= 0 && proxy_fd_port == port) return proxy_fd;

  close_proxy_fd();

  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;

  int yes = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  int connected = 0;
  for (int attempt = 0; attempt < 20; attempt++) {
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
      connected = 1;
      break;
    }
    if (errno != ECONNREFUSED && errno != EINTR) break;
    usleep(1000);
  }

  if (!connected) {
    close(fd);
    return -1;
  }

  proxy_fd = fd;
  proxy_fd_port = port;
  proxy_fd_socket[0] = '\0';
  return proxy_fd;
}

static int connect_proxy_unix(const char *socket_path) {
  if (proxy_fd >= 0 && proxy_fd_socket[0] && strcmp(proxy_fd_socket, socket_path) == 0) return proxy_fd;

  close_proxy_fd();

  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, socket_path, sizeof(addr.sun_path) - 1);

  int connected = 0;
  for (int attempt = 0; attempt < 50; attempt++) {
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
      connected = 1;
      break;
    }
    if (errno != ENOENT && errno != ECONNREFUSED && errno != EINTR) break;
    usleep(1000);
  }

  if (!connected) {
    close(fd);
    return -1;
  }

  proxy_fd = fd;
  proxy_fd_port = 0;
  strncpy(proxy_fd_socket, socket_path, sizeof(proxy_fd_socket) - 1);
  return proxy_fd;
}

static size_t proxy_bad_gateway(char *out) {
  memcpy(out, response_bad_gateway, response_bad_gateway_len);
  return response_bad_gateway_len;
}

static size_t proxy_request_once(int port, const char *request, size_t request_len, char *out, size_t cap) {
  int fd = connect_proxy(port);
  if (fd < 0) {
    return proxy_bad_gateway(out);
  }

  size_t sent = 0;
  while (sent < request_len) {
    ssize_t n = send(fd, request + sent, request_len - sent, MSG_NOSIGNAL);
    if (n <= 0) {
      close_proxy_fd();
      return 0;
    }
    sent += (size_t)n;
  }

  size_t received = 0;
  size_t expected = 0;
  int have_expected = 0;

  while (received < cap) {
    ssize_t n = recv(fd, out + received, cap - received, 0);
    if (n == 0) {
      close_proxy_fd();
      return 0;
    }
    if (n < 0) {
      close_proxy_fd();
      return 0;
    }

    received += (size_t)n;

    if (!have_expected) {
      char *header_end = find_header_end(out, received);
      if (header_end) {
        size_t header_len = (size_t)(header_end - out) + 4;
        expected = header_len + content_length(out, header_len);
        have_expected = 1;
      }
    }

    if (have_expected && received >= expected) break;
  }

  return received;
}

static size_t proxy_request(int port, const char *request, size_t request_len, char *out, size_t cap) {
  size_t received = proxy_request_once(port, request, request_len, out, cap);
  if (received > 0) return received;

  received = proxy_request_once(port, request, request_len, out, cap);
  if (received > 0) return received;

  return proxy_bad_gateway(out);
}

static size_t proxy_tcp_request(
  int port,
  const char *socket_path,
  int handler_index,
  const char *method,
  const char *path,
  const param_t params[MAX_PARAMS],
  int param_count,
  char *out,
  size_t cap,
  const middleware_t *route_middleware,
  int route_middleware_count
) {
  int fd = socket_path && socket_path[0] ? connect_proxy_unix(socket_path) : connect_proxy(port);
  if (fd < 0) {
    return proxy_bad_gateway(out);
  }

  char frame[1024];
  int frame_len = snprintf(frame, sizeof(frame), "%d\t%s\t%s\t%d", handler_index, method, path, param_count);
  if (frame_len <= 0 || (size_t)frame_len >= sizeof(frame)) {
    return proxy_bad_gateway(out);
  }

  size_t cursor = (size_t)frame_len;
  for (int i = 0; i < param_count; i += 1) {
    if (cursor + 1 >= sizeof(frame)) return proxy_bad_gateway(out);
    frame[cursor++] = '\t';

    size_t value_len = params[i].value_len;
    if (cursor + value_len >= sizeof(frame)) return proxy_bad_gateway(out);
    memcpy(frame + cursor, params[i].value, value_len);
    cursor += value_len;
  }

  if (cursor + 1 >= sizeof(frame)) return proxy_bad_gateway(out);
  frame[cursor++] = '\n';
  frame[cursor] = '\0';
  frame_len = (int)cursor;

  size_t sent = 0;
  while (sent < (size_t)frame_len) {
    ssize_t n = send(fd, frame + sent, (size_t)frame_len - sent, MSG_NOSIGNAL);
    if (n <= 0) {
      close_proxy_fd();
      return proxy_bad_gateway(out);
    }
    sent += (size_t)n;
  }

  char response[RESPONSE_SIZE];
  size_t received = 0;
  char *line_end = NULL;

  while (received < sizeof(response)) {
    ssize_t n = recv(fd, response + received, sizeof(response) - received, 0);
    if (n <= 0) {
      close_proxy_fd();
      return proxy_bad_gateway(out);
    }
    received += (size_t)n;

    line_end = memchr(response, '\n', received);
    if (line_end) break;
  }

  if (!line_end) return proxy_bad_gateway(out);

  int status = 200;
  const char *content_type = NULL;
  size_t body_len = 0;

  if (response[0] == 'J' || response[0] == 'T' || response[0] == 'H') {
    *line_end = '\0';
    body_len = (size_t)strtoul(response + 1, NULL, 10);
    if (response[0] == 'J') {
      content_type = "application/json; charset=utf-8";
    } else if (response[0] == 'H') {
      content_type = "text/html; charset=utf-8";
    } else {
      content_type = "text/plain; charset=utf-8";
    }
  } else {
    char *tab1 = memchr(response, '\t', (size_t)(line_end - response));
    if (!tab1) return proxy_bad_gateway(out);
    char *tab2 = memchr(tab1 + 1, '\t', (size_t)(line_end - tab1 - 1));
    if (!tab2) return proxy_bad_gateway(out);

    *tab1 = '\0';
    *tab2 = '\0';
    *line_end = '\0';

    status = atoi(response);
    content_type = tab1 + 1;
    body_len = (size_t)strtoul(tab2 + 1, NULL, 10);
  }
  char *body = line_end + 1;
  size_t body_received = received - (size_t)(body - response);

  while (body_received < body_len && received < sizeof(response)) {
    ssize_t n = recv(fd, response + received, sizeof(response) - received, 0);
    if (n <= 0) {
      close_proxy_fd();
      return proxy_bad_gateway(out);
    }
    received += (size_t)n;
    body_received += (size_t)n;
  }

  if (body_received < body_len) return proxy_bad_gateway(out);

  return build_response_with_middleware(
    out,
    cap,
    status,
    content_type,
    body,
    body_len,
    route_middleware,
    route_middleware_count
  );
}

#if 0
static size_t proxy_request_old(int port, const char *request, size_t request_len, char *out, size_t cap) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    memcpy(out, response_bad_gateway, response_bad_gateway_len);
    return response_bad_gateway_len;
  }

  size_t sent = 0;
  while (sent < request_len) {
    ssize_t n = send(fd, request + sent, request_len - sent, MSG_NOSIGNAL);
    if (n <= 0) {
      close(fd);
      memcpy(out, response_bad_gateway, response_bad_gateway_len);
      return response_bad_gateway_len;
    }
    sent += (size_t)n;
  }
  size_t received = 0;
  size_t expected = 0;
  int have_expected = 0;

  while (received < cap) {
    ssize_t n = recv(fd, out + received, cap - received, 0);
    if (n == 0) break;
    if (n < 0) {
      close(fd);
      memcpy(out, response_bad_gateway, response_bad_gateway_len);
      return response_bad_gateway_len;
    }

    received += (size_t)n;

    if (!have_expected) {
      char *header_end = find_header_end(out, received);
      if (header_end) {
        size_t header_len = (size_t)(header_end - out) + 4;
        expected = header_len + content_length(out, header_len);
        have_expected = 1;
      }
    }

    if (have_expected && received >= expected) break;
  }

  close(fd);

  if (received == 0) {
    memcpy(out, response_bad_gateway, response_bad_gateway_len);
    return response_bad_gateway_len;
  }

  return received;
}
#endif

static size_t respond(method_code_t method_code, const char *path, const char *request, size_t request_len, char *out, size_t cap) {
  if (cors_config.enabled && method_code == METHOD_OPTIONS) {
    memcpy(out, response_options, response_options_len);
    return response_options_len;
  }

  if (!middleware_allows_request(global_middleware, global_middleware_count, request, request_len)) {
    memcpy(out, response_unauthorized, response_unauthorized_len);
    return response_unauthorized_len;
  }

  param_t params[MAX_PARAMS] = {0};
  int param_count = 0;
  int method_mismatch = 0;
  int route_index = find_route(method_code, path, params, &param_count, &method_mismatch);

  if (route_index < 0) {
    if (method_mismatch) {
      memcpy(out, response_method_not_allowed, response_method_not_allowed_len);
      return response_method_not_allowed_len;
    }
    memcpy(out, response_not_found, response_not_found_len);
    return response_not_found_len;
  }

  route_t *route = &routes[route_index];
  if (!middleware_allows_request(route->middleware, route->middleware_count, request, request_len)) {
    memcpy(out, response_unauthorized, response_unauthorized_len);
    return response_unauthorized_len;
  }

  if (route->proxy) {
    if (route->proxy_tcp) {
      return proxy_tcp_request(
        route->proxy_port,
        route->proxy_unix ? route->proxy_socket : NULL,
        route->handler_index,
        route->method,
        path,
        params,
        param_count,
        out,
        cap,
        route->middleware,
        route->middleware_count
      );
    }
    return proxy_request(route->proxy_port, request, request_len, out, cap);
  }

  if (!route->dynamic) {
    memcpy(out, route->prebuilt, route->prebuilt_len);
    return route->prebuilt_len;
  }

  char body[1024];
  size_t body_len = render_body(route, params, param_count, body, sizeof(body));
  return build_response_with_middleware(
    out,
    cap,
    route->status,
    route->content_type,
    body,
    body_len,
    route->middleware,
    route->middleware_count
  );
}

static size_t content_length(char *buf, size_t len) {
  const char needle[] = "content-length:";
  for (size_t i = 0; i + sizeof(needle) - 1 < len; i++) {
    if (strncasecmp(buf + i, needle, sizeof(needle) - 1) != 0) continue;
    char *cursor = buf + i + sizeof(needle) - 1;
    while ((size_t)(cursor - buf) < len && (*cursor == ' ' || *cursor == '\t')) cursor++;
    return (size_t)strtoul(cursor, NULL, 10);
  }
  return 0;
}

static int method_may_have_body(method_code_t method_code) {
  return method_code != METHOD_GET && method_code != METHOD_HEAD && method_code != METHOD_OPTIONS;
}

static int parse_request(char *buf, size_t len, char *method, size_t method_cap, method_code_t *method_code, char *path, size_t path_cap) {
  char *line_end = memmem(buf, len, "\r\n", 2);
  if (!line_end) return 0;

  char *first_space = memchr(buf, ' ', (size_t)(line_end - buf));
  if (!first_space) return 0;
  char *second_space = memchr(first_space + 1, ' ', (size_t)(line_end - first_space - 1));
  if (!second_space) return 0;

  size_t method_len = (size_t)(first_space - buf);
  *method_code = parse_method_code(buf, method_len);
  if (method_len >= method_cap) method_len = method_cap - 1;
  memcpy(method, buf, method_len);
  method[method_len] = '\0';

  size_t path_len = (size_t)(second_space - first_space - 1);
  if (path_len >= path_cap) path_len = path_cap - 1;
  memcpy(path, first_space + 1, path_len);
  path[path_len] = '\0';

  char *query = strchr(path, '?');
  if (query) *query = '\0';
  return 1;
}

static char *find_header_end(char *buf, size_t len) {
  return memmem(buf, len, "\r\n\r\n", 4);
}

static int create_listener(const char *host, int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;

  int yes = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &yes, sizeof(yes));

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);

  if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
    addr.sin_addr.s_addr = INADDR_ANY;
  }

  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
  if (listen(fd, 4096) < 0) return -1;
  if (set_nonblocking(fd) < 0) return -1;
  return fd;
}

static void close_conn(int epoll_fd, conn_t *conn) {
  epoll_ctl(epoll_fd, EPOLL_CTL_DEL, conn->fd, NULL);
  close(conn->fd);
  free(conn);
}

static int update_conn_events(int epoll_fd, conn_t *conn) {
  struct epoll_event event;
  memset(&event, 0, sizeof(event));
  event.events = EPOLLIN | EPOLLRDHUP;
  if (conn->wants_write) {
    event.events |= EPOLLOUT;
  }
  event.data.ptr = conn;
  return epoll_ctl(epoll_fd, EPOLL_CTL_MOD, conn->fd, &event);
}

static void accept_connections(int epoll_fd, int listen_fd) {
  for (;;) {
    int fd = accept4(listen_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (fd < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      return;
    }

    conn_t *conn = calloc(1, sizeof(conn_t));
    if (!conn) {
      close(fd);
      continue;
    }

    conn->fd = fd;
    int yes = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
    struct epoll_event event;
    memset(&event, 0, sizeof(event));
    event.events = EPOLLIN | EPOLLRDHUP;
    event.data.ptr = conn;
    epoll_ctl(epoll_fd, EPOLL_CTL_ADD, fd, &event);
  }
}

static int flush_conn(int epoll_fd, conn_t *conn) {
  while (conn->out_sent < conn->out_len) {
    ssize_t n = send(
      conn->fd,
      conn->out + conn->out_sent,
      conn->out_len - conn->out_sent,
      MSG_NOSIGNAL
    );

    if (n > 0) {
      conn->out_sent += (size_t)n;
      continue;
    }

    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (!conn->wants_write) {
        conn->wants_write = 1;
        update_conn_events(epoll_fd, conn);
      }
      return 1;
    }

    close_conn(epoll_fd, conn);
    return 0;
  }

  conn->out_len = 0;
  conn->out_sent = 0;
  if (conn->wants_write) {
    conn->wants_write = 0;
    update_conn_events(epoll_fd, conn);
  }
  return 1;
}

static int read_conn(int epoll_fd, conn_t *conn) {
  for (;;) {
    ssize_t n = recv(conn->fd, conn->buf + conn->len, sizeof(conn->buf) - conn->len, 0);
    if (n == 0) {
      close_conn(epoll_fd, conn);
      return 0;
    }
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      close_conn(epoll_fd, conn);
      return 0;
    }
    conn->len += (size_t)n;
    if (conn->len == sizeof(conn->buf)) {
      close_conn(epoll_fd, conn);
      return 0;
    }
  }

  return 1;
}

static void process_requests(int epoll_fd, conn_t *conn) {
  for (;;) {
    if (conn->out_sent < conn->out_len) return;

    char *end = find_header_end(conn->buf, conn->len);
    if (!end) return;

    size_t header_len = (size_t)(end - conn->buf) + 4;
    char method[8];
    method_code_t method_code = METHOD_UNKNOWN;
    char path[512];
    int parsed = parse_request(conn->buf, header_len, method, sizeof(method), &method_code, path, sizeof(path));
    size_t body_len = parsed && method_may_have_body(method_code) ? content_length(conn->buf, header_len) : 0;
    size_t request_len = header_len + body_len;
    if (request_len > conn->len) return;

    if (parsed) {
      conn->out_len = respond(method_code, path, conn->buf, request_len, conn->out, sizeof(conn->out));
    } else {
      memcpy(conn->out, response_bad_request, response_bad_request_len);
      conn->out_len = response_bad_request_len;
    }
    conn->out_sent = 0;

    memmove(conn->buf, conn->buf + request_len, conn->len - request_len);
    conn->len -= request_len;

    if (!flush_conn(epoll_fd, conn)) return;
  }
}

static void handle_conn(int epoll_fd, conn_t *conn, uint32_t events) {
  if (events & EPOLLERR) {
    close_conn(epoll_fd, conn);
    return;
  }

  if ((events & EPOLLOUT) && !flush_conn(epoll_fd, conn)) {
    return;
  }

  if ((events & EPOLLIN) && !read_conn(epoll_fd, conn)) {
    return;
  }

  process_requests(epoll_fd, conn);

  if ((events & (EPOLLHUP | EPOLLRDHUP)) && conn->out_sent >= conn->out_len) {
    close_conn(epoll_fd, conn);
  }
}

static void *run_worker(void *data) {
  worker_arg_t *arg = (worker_arg_t *)data;
  int listen_fd = create_listener(arg->host, arg->port);
  if (listen_fd < 0) {
    perror("listen");
    return NULL;
  }

  int epoll_fd = epoll_create1(EPOLL_CLOEXEC);
  if (epoll_fd < 0) {
    perror("epoll_create1");
    close(listen_fd);
    return NULL;
  }

  struct epoll_event listen_event;
  memset(&listen_event, 0, sizeof(listen_event));
  listen_event.events = EPOLLIN;
  listen_event.data.ptr = NULL;
  epoll_ctl(epoll_fd, EPOLL_CTL_ADD, listen_fd, &listen_event);

  if (arg->worker_id == 0) {
    printf("hotpath-c listening on http://%s:%d\n", arg->host, arg->port);
    fflush(stdout);
  }

  struct epoll_event events[MAX_EVENTS];
  for (;;) {
    int n = epoll_wait(epoll_fd, events, MAX_EVENTS, -1);
    if (n < 0) {
      if (errno == EINTR) continue;
      perror("epoll_wait");
      break;
    }

    for (int i = 0; i < n; i++) {
      if (events[i].data.ptr == NULL) {
        accept_connections(epoll_fd, listen_fd);
      } else {
        handle_conn(epoll_fd, (conn_t *)events[i].data.ptr, events[i].events);
      }
    }
  }

  close(listen_fd);
  close(epoll_fd);
  return NULL;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);

  const char *host = "0.0.0.0";
  int port = 3000;
  int threads = 1;
  const char *config = NULL;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--host") == 0 && i + 1 < argc) host = argv[++i];
    else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) port = atoi(argv[++i]);
    else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) threads = atoi(argv[++i]);
    else if (strcmp(argv[i], "--config") == 0 && i + 1 < argc) config = argv[++i];
  }

  if (!config) {
    fprintf(stderr, "--config is required\n");
    return 1;
  }

  if (load_routes(config) != 0) return 1;

  if (threads < 1) threads = 1;
  if (threads > 128) threads = 128;

  if (threads == 1) {
    worker_arg_t arg = {host, port, 0};
    run_worker(&arg);
    return 0;
  }

  pthread_t tids[128];
  worker_arg_t args[128];

  for (int i = 0; i < threads; i++) {
    args[i].host = host;
    args[i].port = port;
    args[i].worker_id = i;
    if (pthread_create(&tids[i], NULL, run_worker, &args[i]) != 0) {
      perror("pthread_create");
      return 1;
    }
  }

  for (int i = 0; i < threads; i++) {
    pthread_join(tids[i], NULL);
  }

  return 0;
}
