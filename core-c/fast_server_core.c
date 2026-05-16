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
#include <unistd.h>

#define MAX_EVENTS 4096
#define MAX_ROUTES 256
#define MAX_PARTS 32
#define MAX_PARAMS 16
#define BUF_SIZE 8192
#define RESPONSE_SIZE 4096

typedef struct {
  int is_param;
  char text[128];
  size_t len;
} route_part_t;

typedef struct {
  char method[8];
  char path[256];
  int status;
  char content_type[128];
  char body[1024];
  route_part_t parts[MAX_PARTS];
  int part_count;
  int dynamic;
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

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static const char *reason_phrase(int status) {
  switch (status) {
    case 200: return "OK";
    case 201: return "Created";
    case 204: return "No Content";
    case 400: return "Bad Request";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 431: return "Request Header Fields Too Large";
    case 500: return "Internal Server Error";
    default: return "OK";
  }
}

static size_t build_response(
  char *out,
  size_t cap,
  int status,
  const char *content_type,
  const char *body,
  size_t body_len
) {
  int n = snprintf(
    out,
    cap,
    "HTTP/1.1 %d %s\r\nContent-Length: %zu\r\n%s%s%s\r\n",
    status,
    reason_phrase(status),
    body_len,
    content_type && content_type[0] ? "content-type: " : "",
    content_type && content_type[0] ? content_type : "",
    content_type && content_type[0] ? "\r\n" : ""
  );
  if (n < 0) return 0;

  size_t head_len = (size_t)n;
  if (head_len + body_len > cap) body_len = cap > head_len ? cap - head_len : 0;
  memcpy(out + head_len, body, body_len);
  return head_len + body_len;
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

static int load_routes(const char *config_path) {
  FILE *file = fopen(config_path, "r");
  if (!file) {
    perror("fopen config");
    return -1;
  }

  char *line = NULL;
  size_t cap = 0;

  while (getline(&line, &cap, file) != -1 && route_count < MAX_ROUTES) {
    line[strcspn(line, "\r\n")] = '\0';
    if (line[0] == '\0') continue;

    char *save = NULL;
    char *method = strtok_r(line, "\t", &save);
    char *path = strtok_r(NULL, "\t", &save);
    char *status = strtok_r(NULL, "\t", &save);
    char *content_type = strtok_r(NULL, "\t", &save);
    char *body = strtok_r(NULL, "", &save);

    if (!method || !path || !status || !content_type || !body) continue;

    route_t *route = &routes[route_count++];
    memset(route, 0, sizeof(*route));
    strncpy(route->method, method, sizeof(route->method) - 1);
    strncpy(route->path, path, sizeof(route->path) - 1);
    route->status = atoi(status);
    strncpy(route->content_type, content_type, sizeof(route->content_type) - 1);
    strncpy(route->body, body, sizeof(route->body) - 1);
    compile_path(route);

    if (!route->dynamic) {
      route->prebuilt_len = build_response(
        route->prebuilt,
        sizeof(route->prebuilt),
        route->status,
        route->content_type,
        route->body,
        strlen(route->body)
      );
    }
  }

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
  size_t written = 0;
  const char *cursor = route->body;

  while (*cursor && written < cap) {
    const char *open = strchr(cursor, '{');
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

    const char *close = strchr(open + 1, '}');
    if (!close) return written;

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

static int find_route(const char *method, const char *path, param_t params[MAX_PARAMS], int *param_count, int *method_mismatch) {
  *method_mismatch = 0;

  for (int i = 0; i < route_count; i++) {
    route_t *route = &routes[i];
    if (!route->dynamic && strcmp(route->path, path) == 0) {
      if (strcmp(route->method, method) == 0) return i;
      *method_mismatch = 1;
    }
  }

  for (int i = 0; i < route_count; i++) {
    route_t *route = &routes[i];
    int local_param_count = 0;
    if (!route->dynamic) continue;
    if (!route_matches_path(route, path, params, &local_param_count)) continue;
    if (strcmp(route->method, method) == 0) {
      *param_count = local_param_count;
      return i;
    }
    *method_mismatch = 1;
  }

  return -1;
}

static size_t respond(const char *method, const char *path, char *out, size_t cap) {
  param_t params[MAX_PARAMS] = {0};
  int param_count = 0;
  int method_mismatch = 0;
  int route_index = find_route(method, path, params, &param_count, &method_mismatch);

  if (route_index < 0) {
    if (method_mismatch) {
      return build_response(out, cap, 405, "", "Method Not Allowed", 18);
    }
    return build_response(out, cap, 404, "", "Not Found", 9);
  }

  route_t *route = &routes[route_index];
  if (!route->dynamic) {
    memcpy(out, route->prebuilt, route->prebuilt_len);
    return route->prebuilt_len;
  }

  char body[1024];
  size_t body_len = render_body(route, params, param_count, body, sizeof(body));
  return build_response(out, cap, route->status, route->content_type, body, body_len);
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

static int parse_request(char *buf, size_t len, char *method, size_t method_cap, char *path, size_t path_cap) {
  char *line_end = memmem(buf, len, "\r\n", 2);
  if (!line_end) return 0;

  char *first_space = memchr(buf, ' ', (size_t)(line_end - buf));
  if (!first_space) return 0;
  char *second_space = memchr(first_space + 1, ' ', (size_t)(line_end - first_space - 1));
  if (!second_space) return 0;

  size_t method_len = (size_t)(first_space - buf);
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
    size_t body_len = content_length(conn->buf, header_len);
    size_t request_len = header_len + body_len;
    if (request_len > conn->len) return;

    char method[8];
    char path[512];

    if (parse_request(conn->buf, request_len, method, sizeof(method), path, sizeof(path))) {
      conn->out_len = respond(method, path, conn->out, sizeof(conn->out));
    } else {
      conn->out_len = build_response(conn->out, sizeof(conn->out), 400, "", "Bad Request", 11);
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
