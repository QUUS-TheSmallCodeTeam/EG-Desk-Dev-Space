#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
/* Darwin hides O_NOFOLLOW when only the POSIX feature set is requested. */
#define _DARWIN_C_SOURCE 1
#endif

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/*
 * One request per process. All request fields, including file contents, arrive
 * on stdin. No pathname is resolved again after its directory FD is opened.
 * The caller must treat every failure after creation as a possibly partial
 * new file; this helper never unlinks by pathname.
 *
 * Request:  "EGDCRQ01", four BE u32 string lengths (root, relative directory,
 *           leaf, operation ID), five BE u64 values (root dev/ino, directory
 *           dev/ino, content length), then those strings and content.
 * Response: "EGDCRS01", BE u32 status, BE u32 flags (bit 0 = created),
 *           BE u64 size, dev, ino, then exact readback bytes on success.
 */

#define REQUEST_HEADER_SIZE 64U
#define RESPONSE_HEADER_SIZE 40U
#define MAX_ROOT_BYTES 4096U
#define MAX_RELATIVE_BYTES 4096U
#define MAX_NAME_BYTES 255U
#define MAX_OPERATION_BYTES 128U
#define MAX_CONTENT_BYTES (16U * 1024U * 1024U)

static const unsigned char REQUEST_MAGIC[8] = {'E', 'G', 'D', 'C', 'R', 'Q', '0', '1'};
static const unsigned char RESPONSE_MAGIC[8] = {'E', 'G', 'D', 'C', 'R', 'S', '0', '1'};

enum status_code {
    STATUS_OK = 0,
    STATUS_BAD_REQUEST = 1,
    STATUS_ROOT_IDENTITY = 2,
    STATUS_DIRECTORY_PATH = 3,
    STATUS_DIRECTORY_IDENTITY = 4,
    STATUS_TARGET_EXISTS = 5,
    STATUS_CREATE = 6,
    STATUS_FILE_METADATA = 7,
    STATUS_WRITE = 8,
    STATUS_SYNC = 9,
    STATUS_READBACK = 10,
    STATUS_CLOSE = 11
};

static uint32_t read_u32(const unsigned char *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static uint64_t read_u64(const unsigned char *p)
{
    uint64_t value = 0;
    for (size_t i = 0; i < 8; ++i) {
        value = (value << 8) | (uint64_t)p[i];
    }
    return value;
}

static void put_u32(unsigned char *p, uint32_t value)
{
    for (size_t i = 0; i < 4; ++i) {
        p[3 - i] = (unsigned char)(value & 0xffU);
        value >>= 8;
    }
}

static void put_u64(unsigned char *p, uint64_t value)
{
    for (size_t i = 0; i < 8; ++i) {
        p[7 - i] = (unsigned char)(value & 0xffU);
        value >>= 8;
    }
}

static int read_exact(int fd, void *buffer, size_t length)
{
    unsigned char *p = buffer;
    while (length != 0) {
        ssize_t count = read(fd, p, length);
        if (count < 0 && errno == EINTR) {
            continue;
        }
        if (count <= 0) {
            return -1;
        }
        p += (size_t)count;
        length -= (size_t)count;
    }
    return 0;
}

static int write_exact(int fd, const void *buffer, size_t length)
{
    const unsigned char *p = buffer;
    while (length != 0) {
        ssize_t count = write(fd, p, length);
        if (count < 0 && errno == EINTR) {
            continue;
        }
        if (count <= 0) {
            return -1;
        }
        p += (size_t)count;
        length -= (size_t)count;
    }
    return 0;
}

static int read_string(uint32_t length, char **out)
{
    char *value = malloc((size_t)length + 1U);
    if (value == NULL) {
        return -1;
    }
    if (read_exact(STDIN_FILENO, value, length) != 0 ||
        memchr(value, '\0', length) != NULL) {
        free(value);
        return -1;
    }
    value[length] = '\0';
    *out = value;
    return 0;
}

static int is_component(const char *value, size_t length)
{
    return length != 0 && !(length == 1 && value[0] == '.') &&
           !(length == 2 && value[0] == '.' && value[1] == '.') &&
           memchr(value, '/', length) == NULL;
}

static int valid_relative_directory(const char *value)
{
    if (*value == '\0') {
        return 1; /* The root itself. */
    }
    const char *part = value;
    for (const char *p = value; ; ++p) {
        if (*p == '/' || *p == '\0') {
            if (!is_component(part, (size_t)(p - part))) {
                return 0;
            }
            if (*p == '\0') {
                return 1;
            }
            part = p + 1;
        }
    }
}

static int same_identity(const struct stat *st, uint64_t dev, uint64_t ino)
{
    return S_ISDIR(st->st_mode) && (uint64_t)st->st_dev == dev &&
           (uint64_t)st->st_ino == ino;
}

static int reply(enum status_code status, int created, uint64_t size,
                 uint64_t dev, uint64_t ino, const unsigned char *readback)
{
    unsigned char header[RESPONSE_HEADER_SIZE] = {0};
    memcpy(header, RESPONSE_MAGIC, sizeof RESPONSE_MAGIC);
    put_u32(header + 8, (uint32_t)status);
    put_u32(header + 12, created ? 1U : 0U);
    put_u64(header + 16, size);
    put_u64(header + 24, dev);
    put_u64(header + 32, ino);
    if (write_exact(STDOUT_FILENO, header, sizeof header) != 0) {
        return -1;
    }
    if (status == STATUS_OK && write_exact(STDOUT_FILENO, readback, (size_t)size) != 0) {
        return -1;
    }
    return 0;
}

int main(void)
{
    unsigned char header[REQUEST_HEADER_SIZE];
    char *root = NULL;
    char *relative = NULL;
    char *name = NULL;
    char *operation = NULL;
    unsigned char *content = NULL;
    unsigned char *readback = NULL;
    int directory_fd = -1;
    int file_fd = -1;
    int created = 0;
    uint64_t file_dev = 0;
    uint64_t file_ino = 0;
    uint64_t size = 0;
    enum status_code status = STATUS_BAD_REQUEST;
    struct stat st;

    if (read_exact(STDIN_FILENO, header, sizeof header) != 0 ||
        memcmp(header, REQUEST_MAGIC, sizeof REQUEST_MAGIC) != 0) {
        goto done;
    }

    uint32_t root_length = read_u32(header + 8);
    uint32_t relative_length = read_u32(header + 12);
    uint32_t name_length = read_u32(header + 16);
    uint32_t operation_length = read_u32(header + 20);
    uint64_t root_dev = read_u64(header + 24);
    uint64_t root_ino = read_u64(header + 32);
    uint64_t directory_dev = read_u64(header + 40);
    uint64_t directory_ino = read_u64(header + 48);
    size = read_u64(header + 56);

    if (root_length == 0 || root_length > MAX_ROOT_BYTES ||
        relative_length > MAX_RELATIVE_BYTES ||
        name_length == 0 || name_length > MAX_NAME_BYTES ||
        operation_length == 0 || operation_length > MAX_OPERATION_BYTES ||
        size > MAX_CONTENT_BYTES ||
        read_string(root_length, &root) != 0 ||
        read_string(relative_length, &relative) != 0 ||
        read_string(name_length, &name) != 0 ||
        read_string(operation_length, &operation) != 0) {
        goto done;
    }

    content = malloc(size == 0 ? 1U : (size_t)size);
    if (content == NULL || read_exact(STDIN_FILENO, content, (size_t)size) != 0) {
        goto done;
    }
    unsigned char extra;
    ssize_t extra_count;
    do {
        extra_count = read(STDIN_FILENO, &extra, 1);
    } while (extra_count < 0 && errno == EINTR);
    if (extra_count != 0 || root[0] != '/' ||
        (root_length > 1 && root[root_length - 1] == '/') ||
        !valid_relative_directory(relative) ||
        !is_component(name, name_length)) {
        goto done;
    }

    directory_fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory_fd < 0 || fstat(directory_fd, &st) != 0 ||
        !same_identity(&st, root_dev, root_ino)) {
        status = STATUS_ROOT_IDENTITY;
        goto done;
    }

    if (*relative != '\0') {
        char *part = relative;
        for (;;) {
            char *separator = strchr(part, '/');
            if (separator != NULL) {
                *separator = '\0';
            }
            int next_fd = openat(directory_fd, part,
                                 O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (next_fd < 0) {
                status = STATUS_DIRECTORY_PATH;
                goto done;
            }
            (void)close(directory_fd);
            directory_fd = next_fd;
            if (separator == NULL) {
                break;
            }
            part = separator + 1;
        }
    }
    if (fstat(directory_fd, &st) != 0 ||
        !same_identity(&st, directory_dev, directory_ino)) {
        status = STATUS_DIRECTORY_IDENTITY;
        goto done;
    }

    file_fd = openat(directory_fd, name,
                     O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (file_fd < 0) {
        status = errno == EEXIST ? STATUS_TARGET_EXISTS : STATUS_CREATE;
        goto done;
    }
    created = 1;
    status = STATUS_FILE_METADATA;
    if (fstat(file_fd, &st) != 0) {
        goto done;
    }
    file_dev = (uint64_t)st.st_dev;
    file_ino = (uint64_t)st.st_ino;
    if (!S_ISREG(st.st_mode) || fchmod(file_fd, 0600) != 0) {
        goto done;
    }

    status = STATUS_WRITE;
    if (write_exact(file_fd, content, (size_t)size) != 0) {
        goto done;
    }
    status = STATUS_SYNC;
    if (fsync(file_fd) != 0) {
        goto done;
    }

    status = STATUS_READBACK;
    readback = malloc(size == 0 ? 1U : (size_t)size);
    if (readback == NULL || lseek(file_fd, 0, SEEK_SET) != 0 ||
        read_exact(file_fd, readback, (size_t)size) != 0 ||
        memcmp(content, readback, (size_t)size) != 0 ||
        fstat(file_fd, &st) != 0 || !S_ISREG(st.st_mode) ||
        st.st_size != (off_t)size ||
        (uint64_t)st.st_dev != file_dev ||
        (uint64_t)st.st_ino != file_ino) {
        goto done;
    }

    status = STATUS_CLOSE;
    if (close(file_fd) != 0) {
        file_fd = -1;
        goto done;
    }
    file_fd = -1;
    status = STATUS_OK;

done:
    if (file_fd >= 0) {
        (void)close(file_fd);
    }
    if (directory_fd >= 0) {
        (void)close(directory_fd);
    }
    /* Error receipts never assert how much of a newly created file survived. */
    int response_ok = reply(status, created, status == STATUS_OK ? size : 0,
                            file_dev, file_ino, readback);
    free(root);
    free(relative);
    free(name);
    free(operation);
    free(content);
    free(readback);
    return status == STATUS_OK && response_ok == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
