#define _GNU_SOURCE

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_ROUTES 256
#define MAX_PARTS 32
#define MAX_PARAMS 16
#define MAX_BODY 1024
#define MAX_CONTENT_TYPE 128
#define MAX_FRAME 4096

typedef struct {
  int is_param;
  char text[128];
  size_t len;
} route_part_t;

typedef struct {
  char method[8];
  char path[256];
  int status;
  char content_type[MAX_CONTENT_TYPE];
  char body[MAX_BODY];
  route_part_t parts[MAX_PARTS];
  int part_count;
  int dynamic;
  int simple_template;
  int template_param_index;
  char template_prefix[512];
  size_t template_prefix_len;
  char template_suffix[512];
  size_t template_suffix_len;
} route_t;

typedef struct {
  const char *name;
  size_t name_len;
  const char *value;
  size_t value_len;
} param_t;

static route_t routes[MAX_ROUTES];
static int route_count = 0;

static size_t append_bytes(char *out, size_t cap, size_t written, const char *data, size_t len) {
  if (written >= cap) return written;
  if (written + len > cap) len = cap - written;
  memcpy(out + written, data, len);
  return written + len;
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

static int route_matches_path(const route_t *route, const char *path, param_t params[MAX_PARAMS], int *param_count) {
  const char *cursor = path;
  int part_index = 0;
  *param_count = 0;

  if (*cursor == '/') cursor++;
  if (route->part_count == 0) return *cursor == '\0';

  while (part_index < route->part_count) {
    const char *part_start = cursor;
    const char *slash = strchr(cursor, '/');
    size_t part_len = slash ? (size_t)(slash - part_start) : strlen(part_start);
    const route_part_t *expected = &route->parts[part_index];

    if (expected->is_param) {
      if (*param_count >= MAX_PARAMS) return 0;
      params[*param_count].name = expected->text;
      params[*param_count].name_len = expected->len;
      params[*param_count].value = part_start;
      params[*param_count].value_len = part_len;
      (*param_count)++;
    } else if (expected->len != part_len || memcmp(expected->text, part_start, part_len) != 0) {
      return 0;
    }

    part_index++;
    if (!slash) break;
    cursor = slash + 1;
  }

  return part_index == route->part_count && strchr(cursor, '/') == NULL;
}

static param_t *find_param(param_t params[MAX_PARAMS], int param_count, const char *name, size_t name_len) {
  for (int i = 0; i < param_count; i++) {
    if (params[i].name_len == name_len && memcmp(params[i].name, name, name_len) == 0) return &params[i];
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
      return append_bytes(out, cap, written, cursor, strlen(cursor));
    }

    written = append_bytes(out, cap, written, cursor, (size_t)(open - cursor));
    param_t *param = find_param(params, param_count, open + 1, (size_t)(close - open - 1));
    if (param) {
      written = append_bytes(out, cap, written, param->value, param->value_len);
    }
    cursor = close + 1;
  }

  return written;
}

static void add_route_from_fields(char *fields[], int count) {
  if (route_count >= MAX_ROUTES || count < 6) return;

  route_t *route = &routes[route_count++];
  memset(route, 0, sizeof(*route));
  strncpy(route->method, fields[1], sizeof(route->method) - 1);
  strncpy(route->path, fields[2], sizeof(route->path) - 1);
  route->status = atoi(fields[3]);
  strncpy(route->content_type, fields[4], sizeof(route->content_type) - 1);
  strncpy(route->body, fields[5], sizeof(route->body) - 1);
  compile_path(route);
  compile_template(route);
}

static int load_config(const char *config_path) {
  FILE *file = fopen(config_path, "r");
  if (!file) return -1;

  route_count = 0;
  char *line = NULL;
  size_t cap = 0;

  while (getline(&line, &cap, file) != -1) {
    line[strcspn(line, "\r\n")] = '\0';
    if (line[0] == '\0' || line[0] == '#') continue;

    char *fields[16] = {0};
    int field_count = split_tabs(line, fields, 16);
    if (field_count == 0) continue;
    if (strcmp(fields[0], "ROUTE") == 0) {
      add_route_from_fields(fields, field_count);
    }
  }

  free(line);
  fclose(file);
  return 0;
}

int hotpath_router_load(const char *config_path) {
  return load_config(config_path);
}

int hotpath_router_handle(
  const char *method,
  int method_len,
  const char *path,
  int path_len,
  char *out,
  int cap
) {
  if (!method || !path || !out || cap <= 16) return 0;

  char path_buf[256];
  if (path_len <= 0 || (size_t)path_len >= sizeof(path_buf)) return 0;
  memcpy(path_buf, path, (size_t)path_len);
  path_buf[path_len] = '\0';

  param_t params[MAX_PARAMS] = {0};
  int param_count = 0;

  for (int i = 0; i < route_count; i++) {
    route_t *route = &routes[i];
    if ((int)strlen(route->method) != method_len || memcmp(route->method, method, (size_t)method_len) != 0) continue;
    if (route->dynamic) {
      if (!route_matches_path(route, path_buf, params, &param_count)) continue;
    } else if (strcmp(route->path, path_buf) != 0) {
      continue;
    }

    char body[MAX_FRAME];
    size_t body_len = route->dynamic
      ? render_body(route, params, param_count, body, sizeof(body))
      : strlen(route->body);
    const char *body_ptr = route->dynamic ? body : route->body;

    char kind = 'X';
    if (route->status == 200 && strcmp(route->content_type, "application/json; charset=utf-8") == 0) kind = 'J';
    if (route->status == 200 && strcmp(route->content_type, "text/plain; charset=utf-8") == 0) kind = 'T';
    if (route->status == 200 && strcmp(route->content_type, "text/html; charset=utf-8") == 0) kind = 'H';

    int head_len = 0;
    if (kind != 'X') {
      head_len = snprintf(out, (size_t)cap, "%c%zu\n", kind, body_len);
    } else {
      head_len = snprintf(out, (size_t)cap, "%d\t%s\t%zu\n", route->status, route->content_type, body_len);
    }
    if (head_len <= 0 || head_len >= cap) return 0;

    size_t available = (size_t)(cap - head_len);
    if (body_len > available) return 0;
    memcpy(out + head_len, body_ptr, body_len);
    return head_len + (int)body_len;
  }

  return 0;
}

int hotpath_router_render_id(
  int route_index,
  const char *param_value,
  int param_value_len,
  char *out,
  int cap
) {
  if (route_index < 0 || route_index >= route_count || !out || cap <= 16) return 0;

  route_t *route = &routes[route_index];
  param_t params[MAX_PARAMS] = {0};
  int param_count = 0;

  if (route->dynamic && route->part_count > 0 && param_value && param_value_len >= 0) {
    for (int i = 0; i < route->part_count; i++) {
      if (!route->parts[i].is_param) continue;
      params[param_count].name = route->parts[i].text;
      params[param_count].name_len = route->parts[i].len;
      params[param_count].value = param_value;
      params[param_count].value_len = (size_t)param_value_len;
      param_count++;
      break;
    }
  }

  char body[MAX_FRAME];
  size_t body_len = route->dynamic
    ? render_body(route, params, param_count, body, sizeof(body))
    : strlen(route->body);
  const char *body_ptr = route->dynamic ? body : route->body;

  char kind = 'X';
  if (route->status == 200 && strcmp(route->content_type, "application/json; charset=utf-8") == 0) kind = 'J';
  if (route->status == 200 && strcmp(route->content_type, "text/plain; charset=utf-8") == 0) kind = 'T';
  if (route->status == 200 && strcmp(route->content_type, "text/html; charset=utf-8") == 0) kind = 'H';

  int head_len = 0;
  if (kind != 'X') {
    head_len = snprintf(out, (size_t)cap, "%c%zu\n", kind, body_len);
  } else {
    head_len = snprintf(out, (size_t)cap, "%d\t%s\t%zu\n", route->status, route->content_type, body_len);
  }
  if (head_len <= 0 || head_len >= cap) return 0;

  size_t available = (size_t)(cap - head_len);
  if (body_len > available) return 0;
  memcpy(out + head_len, body_ptr, body_len);
  return head_len + (int)body_len;
}
