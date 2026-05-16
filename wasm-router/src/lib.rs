static mut REQUEST: [u8; 2048] = [0; 2048];
static mut RESPONSE: [u8; 512] = [0; 512];
static mut RESPONSE_LEN: usize = 0;
static mut RESPONSE_STATUS: u32 = 200;

#[unsafe(no_mangle)]
pub extern "C" fn alloc(_size: usize) -> *mut u8 {
    &raw mut REQUEST as *mut u8
}

#[unsafe(no_mangle)]
pub extern "C" fn dealloc(_ptr: *mut u8, _len: usize) {}

#[unsafe(no_mangle)]
pub extern "C" fn response_ptr() -> usize {
    &raw const RESPONSE as *const u8 as usize
}

#[unsafe(no_mangle)]
pub extern "C" fn response_len() -> usize {
    unsafe { RESPONSE_LEN }
}

#[unsafe(no_mangle)]
pub extern "C" fn response_status() -> u32 {
    unsafe { RESPONSE_STATUS }
}

#[unsafe(no_mangle)]
pub extern "C" fn handle(ptr: *const u8, len: usize) -> u64 {
    let req = unsafe { core::slice::from_raw_parts(ptr, len) };
    let path = parse_path(req);
    write_response(path);
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn handle_path(ptr: *const u8, len: usize) -> u64 {
    let path = unsafe { core::slice::from_raw_parts(ptr, len) };
    write_response(path);
    0
}

fn parse_path(req: &[u8]) -> &[u8] {
    let Some(space) = req.iter().position(|byte| *byte == b' ') else {
        return b"/";
    };
    let rest = &req[space + 1..];
    let end = rest
        .iter()
        .position(|byte| *byte == b'\n' || *byte == b'?' || *byte == b' ')
        .unwrap_or(rest.len());
    &rest[..end]
}

fn write_response(path: &[u8]) {
    let name = path.strip_prefix(b"/hello/");
    let written = if let Some(name) = name {
        unsafe {
            RESPONSE_STATUS = 200;
        }
        write_hello(name)
    } else if path == b"/" {
        unsafe {
            RESPONSE_STATUS = 200;
        }
        write_static(b"ok")
    } else {
        unsafe {
            RESPONSE_STATUS = 404;
        }
        write_static(b"Not Found")
    };

    unsafe {
        RESPONSE_LEN = written;
    }
}

fn write_static(value: &[u8]) -> usize {
    unsafe {
        RESPONSE[..value.len()].copy_from_slice(value);
    }
    value.len()
}

fn write_hello(name: &[u8]) -> usize {
    let prefix = b"hello ";
    unsafe {
        RESPONSE[..prefix.len()].copy_from_slice(prefix);
        RESPONSE[prefix.len()..prefix.len() + name.len()].copy_from_slice(name);
    }
    prefix.len() + name.len()
}
