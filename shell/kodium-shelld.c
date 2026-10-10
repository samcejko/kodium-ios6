// kodium-shelld: shells for Kodium's terminal. Kodium is an app of /var/mobile/Applications, and iOS's sandbox does not
// let such an app start processes; launchd listens on 127.0.0.1:47070 instead (com.samcejko.kodium.shelld.plist) and
// starts this, as the user mobile, for each connection - the connection on stdin and stdout (inetd style, as sshd on a
// jailbroken iOS).
//
// The connection's first line: KODIUM1 <token> <columns> <rows> <folder, percent-encoded>. The token is the one Kodium
// wrote into its container at its start (Library/Kodium/shell.token): only Kodium and processes of mobile or root can
// read it there - not a web page, not another app of the App Store. Then a login shell (bash) runs on a pseudo terminal
// of that size in that folder; its output goes to the connection as it comes, and what comes from the connection are
// frames: 'd' <length: 2 bytes> <bytes> - input for the shell, 'r' <columns: 2 bytes> <rows: 2 bytes> - a new size.
// When the shell ends, the connection is closed; when the connection is closed, the shell gets a hangup.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <glob.h>
#include <poll.h>
#include <signal.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <libgen.h>

#define HEADER_MAX 4096
#define TOKEN_MAX 128

static void say(const char *line)
{
    ssize_t n = write(1, line, strlen(line));
    (void)n;
}

// the whole buffer out (a pipe or socket may take it in parts)
static int write_all(int fd, const char *p, size_t n)
{
    while (n > 0) {
        ssize_t w = write(fd, p, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN) {
                struct pollfd pf = { fd, POLLOUT, 0 };
                poll(&pf, 1, 1000);
                continue;
            }
            return -1;
        }
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

// the first line of the connection (without its newline); -1 if it does not come or is too long
static int read_header(char *line, size_t size)
{
    size_t n = 0;
    while (n + 1 < size) {
        struct pollfd pf = { 0, POLLIN, 0 };
        if (poll(&pf, 1, 10000) <= 0) return -1;
        ssize_t r = read(0, line + n, 1);
        if (r <= 0) return -1;
        if (line[n] == '\n') {
            line[n] = 0;
            return 0;
        }
        n++;
    }
    return -1;
}

static int token_equal(const char *a, const char *b)
{
    size_t la = strlen(a), lb = strlen(b);
    unsigned char diff = (unsigned char)(la != lb);
    for (size_t i = 0; i < la && i < lb; i++) diff |= (unsigned char)(a[i] ^ b[i]);
    return diff == 0 && la >= 32;
}

static int token_in_file(const char *path, const char *given)
{
    char token[TOKEN_MAX + 1];
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 0;
    ssize_t n = read(fd, token, TOKEN_MAX);
    close(fd);
    if (n <= 0) return 0;
    token[n] = 0;
    while (n > 0 && (token[n - 1] == '\n' || token[n - 1] == '\r' || token[n - 1] == ' ')) token[--n] = 0;
    return token_equal(token, given);
}

// Kodium's token: in the container of an installed Kodium.app, or in mobile's Library for one in /Applications
static int token_valid(const char *given)
{
    int ok = 0;
    glob_t g;
    if (glob("/var/mobile/Applications/*/Kodium.app", 0, NULL, &g) == 0) {
        for (size_t i = 0; i < g.gl_pathc && !ok; i++) {
            char path[1024], copy[1024];
            snprintf(copy, sizeof copy, "%s", g.gl_pathv[i]);
            snprintf(path, sizeof path, "%s/Library/Kodium/shell.token", dirname(copy));
            ok = token_in_file(path, given);
        }
        globfree(&g);
    }
    if (!ok) ok = token_in_file("/var/mobile/Library/Kodium/shell.token", given);
    return ok;
}

static void percent_decode(char *s)
{
    char *out = s;
    for (; *s; s++) {
        if (*s == '%' && s[1] && s[2]) {
            char hex[3] = { s[1], s[2], 0 };
            *out++ = (char)strtol(hex, NULL, 16);
            s += 2;
        } else {
            *out++ = *s;
        }
    }
    *out = 0;
}

static void set_size(int fd, int cols, int rows)
{
    struct winsize ws;
    memset(&ws, 0, sizeof ws);
    ws.ws_col = (unsigned short)(cols > 0 && cols < 1000 ? cols : 80);
    ws.ws_row = (unsigned short)(rows > 0 && rows < 1000 ? rows : 24);
    ioctl(fd, TIOCSWINSZ, &ws);
}

static int exists(const char *path, int dir)
{
    struct stat st;
    return stat(path, &st) == 0 && (dir ? S_ISDIR(st.st_mode) : S_ISREG(st.st_mode));
}

int main(void)
{
    char header[HEADER_MAX], token[TOKEN_MAX + 1], folder[HEADER_MAX];
    int cols = 80, rows = 24;
    signal(SIGPIPE, SIG_IGN);
    if (read_header(header, sizeof header) != 0) return 1;
    folder[0] = 0;
    if (sscanf(header, "KODIUM1 %128s %d %d %4095s", token, &cols, &rows, folder) < 3) {
        say("ERR header\n");
        return 1;
    }
    if (!token_valid(token)) {
        say("ERR token\n");
        return 1;
    }
    percent_decode(folder);
    const char *home = "/var/mobile";
    const char *cwd = folder[0] && exists(folder, 1) ? folder : home;

    int master = posix_openpt(O_RDWR | O_NOCTTY);
    if (master < 0 || grantpt(master) != 0 || unlockpt(master) != 0) {
        say("ERR pty\n");
        return 1;
    }
    char *slave_name = ptsname(master);
    if (!slave_name) {
        say("ERR pty\n");
        return 1;
    }
    char slave_path[256];
    snprintf(slave_path, sizeof slave_path, "%s", slave_name);
    set_size(master, cols, rows);

    pid_t pid = fork();
    if (pid < 0) {
        say("ERR fork\n");
        return 1;
    }
    if (pid == 0) {
        setsid();
        int slave = open(slave_path, O_RDWR);
        if (slave < 0) _exit(127);
        ioctl(slave, TIOCSCTTY, 0);
        dup2(slave, 0);
        dup2(slave, 1);
        dup2(slave, 2);
        for (int fd = 3; fd < 256; fd++) close(fd);
        signal(SIGPIPE, SIG_DFL);
        if (chdir(cwd) != 0) {
            int ignored = chdir(home);
            (void)ignored;
        }
        const char *shell = exists("/bin/bash", 0) ? "/bin/bash" : "/bin/sh";
        char pwd[HEADER_MAX + 8], sh[64];
        snprintf(pwd, sizeof pwd, "PWD=%s", cwd);
        snprintf(sh, sizeof sh, "SHELL=%s", shell);
        char *env[] = {
            "HOME=/var/mobile", "USER=mobile", "LOGNAME=mobile", sh, pwd,
            "PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            // (no locale: iOS 6 has none installed - bash would only warn that it cannot set it)
            "TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=Kodium",
            NULL
        };
        char *argv[] = { strcmp(shell, "/bin/bash") == 0 ? "-bash" : "-sh", NULL };
        execve(shell, argv, env);
        _exit(127);
    }

    say("OK\n");
    int flags = fcntl(1, F_GETFL);
    fcntl(1, F_SETFL, flags | O_NONBLOCK);

    // the connection's frames, gathered until whole
    unsigned char in[8192 + 8];
    size_t have = 0;
    char out[16384];
    for (;;) {
        struct pollfd pf[2] = { { 0, POLLIN, 0 }, { master, POLLIN, 0 } };
        if (poll(pf, 2, -1) < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (pf[1].revents & (POLLIN | POLLHUP | POLLERR)) {
            ssize_t r = read(master, out, sizeof out);
            if (r <= 0) {
                if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
                break;   // (the shell ended)
            }
            if (write_all(1, out, (size_t)r) != 0) break;
        }
        if (pf[0].revents & (POLLIN | POLLHUP | POLLERR)) {
            ssize_t r = read(0, in + have, sizeof in - 8 - have);
            if (r <= 0) {
                if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
                break;   // (Kodium closed the connection)
            }
            have += (size_t)r;
            size_t at = 0;
            while (have - at >= 3) {
                unsigned char type = in[at];
                size_t a = in[at + 1], b = in[at + 2];
                if (type == 'd') {
                    size_t len = (a << 8) | b;
                    if (have - at < 3 + len) break;
                    if (write_all(master, (const char *)in + at + 3, len) != 0) goto done;
                    at += 3 + len;
                } else if (type == 'r') {
                    if (have - at < 5) break;
                    set_size(master, (int)((a << 8) | b), (int)((in[at + 3] << 8) | in[at + 4]));
                    kill(-pid, SIGWINCH);
                    at += 5;
                } else {
                    goto done;   // (not a frame of Kodium's)
                }
            }
            memmove(in, in + at, have - at);
            have -= at;
            if (have >= sizeof in - 8) goto done;
        }
    }
done:
    kill(-pid, SIGHUP);
    for (int i = 0; i < 20; i++) {
        if (waitpid(pid, NULL, WNOHANG) == pid) return 0;
        usleep(50000);
    }
    kill(-pid, SIGKILL);
    waitpid(pid, NULL, 0);
    return 0;
}
