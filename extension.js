// This extension was generated with AI assistance for personal use.
// Do not upload it to extensions.gnome.org unless you understand the
// code and are able to maintain it yourself.
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const LanWindow = GObject.registerClass(
class LanWindow extends St.BoxLayout {
    _init(onStateChange) {
        super._init({
            vertical: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
            style_class: 'lan-scanner-window',
            style: 'background-color: rgba(30,30,30,0.98); ' +
                   'border: 1px solid rgba(255,255,255,0.15); ' +
                   'border-radius: 12px; padding: 12px; ' +
                   'min-width: 640px; max-width: 720px;'
        });

        this._onStateChange = onStateChange;

        this._devices = [];
        this._scanning = false;
        this._subnet = null;
        this._myIP = null;
        this._myMac = null;
        this._activePings = 0;
        this._maxConcurrent = 50;
        this._pendingTimeouts = [];
        this._cancellable = new Gio.Cancellable();

        this._buildUI();

        Main.layoutManager.uiGroup.add_child(this);
        this.hide();

        this._detectSubnet();
    }

    _buildUI() {
        let titleBar = new St.BoxLayout({
            style: 'spacing: 8px; padding-bottom: 8px;'
        });

        this._titleLabel = new St.Label({
            text: '🖧  LAN Scanner',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: 'font-weight: bold; font-size: 1.15em;'
        });

        let closeButton = new St.Button({
            label: '✕',
            style_class: 'button',
            style: 'padding: 2px 10px; border-radius: 4px;'
        });
        closeButton.connect('clicked', () => this.close());

        titleBar.add_child(this._titleLabel);
        titleBar.add_child(closeButton);
        this.add_child(titleBar);

        // Drag prozora po naslovnoj traci
        this._titleLabel.reactive = true;
        this._titleLabel.connect('button-press-event', (a, ev) => this._onDragStart(ev));

        // Kontrole: subnet + gumbi
        let controls = new St.BoxLayout({
            style: 'spacing: 10px; padding: 6px 0;'
        });

        let subnetLabel = new St.Label({
            text: 'Subnet:',
            y_align: Clutter.ActorAlign.CENTER
        });

        this._subnetEntry = new St.Entry({
            hint_text: '192.168.1.0/24',
            can_focus: true,
            track_hover: true,
            style: 'width: 180px;'
        });

        this._scanButton = new St.Button({
            label: 'Scan',
            style_class: 'button',
            style: 'padding: 5px 15px; border-radius: 4px;'
        });
        this._scanButton.connect('clicked', () => this._startScan());

        this._detectButton = new St.Button({
            label: 'Auto',
            style_class: 'button',
            style: 'padding: 5px 15px; border-radius: 4px;'
        });
        this._detectButton.connect('clicked', () => this._detectSubnet());

        controls.add_child(subnetLabel);
        controls.add_child(this._subnetEntry);
        controls.add_child(this._scanButton);
        controls.add_child(this._detectButton);
        this.add_child(controls);

        // Rezultati u scrollu
        let scroll = new St.ScrollView({
            style: 'max-height: 620px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            y_expand: true
        });
        this._resultsBox = new St.BoxLayout({vertical: true});
        scroll.set_child(this._resultsBox);
        this.add_child(scroll);

        // Statusni redak
        this._statusLabel = new St.Label({
            text: 'Click "Scan" to start',
            style: 'padding-top: 8px; color: #aaa; font-size: 0.9em;'
        });
        this.add_child(this._statusLabel);
    }

    _onDragStart(ev) {
        let [sx, sy] = ev.get_coords();
        let [wx, wy] = this.get_position();
        this._dragOffset = [sx - wx, sy - wy];

        this._dragMotionId = global.stage.connect('motion-event', (s, mev) => {
            let [mx, my] = mev.get_coords();
            this.set_position(
                Math.round(mx - this._dragOffset[0]),
                Math.round(my - this._dragOffset[1])
            );
            return Clutter.EVENT_STOP;
        });
        this._dragReleaseId = global.stage.connect('button-release-event', () => {
            if (this._dragMotionId) {
                global.stage.disconnect(this._dragMotionId);
                this._dragMotionId = null;
            }
            if (this._dragReleaseId) {
                global.stage.disconnect(this._dragReleaseId);
                this._dragReleaseId = null;
            }
            return Clutter.EVENT_STOP;
        });
        return Clutter.EVENT_STOP;
    }

    _setSubtitle(text) {
        if (this._onStateChange)
            this._onStateChange(text);
    }

    open() {
        let monitor = Main.layoutManager.primaryMonitor;
        this.show();
        let w = this.width;
        let topGap = Main.panel.height + 12;
        this.set_position(
            Math.round(monitor.x + (monitor.width - w) / 2),
            Math.round(monitor.y + topGap)
        );
        this._isOpen = true;
        if (this._onOpenChange)
            this._onOpenChange(true);
    }

    close() {
        this.hide();
        this._isOpen = false;
        if (this._onOpenChange)
            this._onOpenChange(false);
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    _detectSubnet() {
        try {
            let proc = Gio.Subprocess.new(
                ['ip', '-4', 'addr', 'show'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) {
                        let lines = stdout.split('\n');
                        for (let line of lines) {
                            let match = line.match(/inet ([\d.]+)\/(\d+)/);
                            if (match && !match[1].startsWith('127.')) {
                                this._myIP = match[1];
                                let cidr = match[2];
                                let parts = this._myIP.split('.');
                                this._subnet = `${parts[0]}.${parts[1]}.${parts[2]}.0/${cidr}`;
                                this._subnetEntry.set_text(this._subnet);
                                this._updateStatus(`Detected subnet: ${this._subnet}`);
                                this._getMyMacAddress((mac) => { this._myMac = mac; });
                                return;
                            }
                        }
                    }
                } catch (e) {
                }
                this._subnet = '192.168.1.0/24';
                this._subnetEntry.set_text(this._subnet);
                this._updateStatus('Use default subnet');
                this._getMyMacAddress((mac) => { this._myMac = mac; });
            });
        } catch (e) {
            this._subnet = '192.168.1.0/24';
            this._subnetEntry.set_text(this._subnet);
            this._updateStatus('Use default subnet');
        }
    }
    
    _startScan() {
        if (this._scanning) return;
        
        let subnet = this._subnetEntry.get_text();
        if (!subnet || !subnet.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/)) {
            this._updateStatus('Invalid subnet format!');
            return;
        }
        
        this._scanning = true;
        this._devices = [];
        this._pendingTimeouts.forEach(id => GLib.source_remove(id));
        this._pendingTimeouts = [];
        this._resultsBox.destroy_all_children();
        this._scanButton.set_label('Scanning ...');
        this._updateStatus('Start scanning ...');
        this._setSubtitle('scanning…');
        
        let [baseIP, mask] = subnet.split('/');
        let parts = baseIP.split('.');
        let base = `${parts[0]}.${parts[1]}.${parts[2]}`;
        
        if (this._myIP && this._myMac) {
            this._getFullDeviceInfo(this._myIP, this._myMac, true, (deviceInfo) => {
                this._devices.push(deviceInfo);
            });
        }
        
        this._scanIPRange(base, 1, 254);
    }
    
    _scanIPRange(base, start, end) {
        let total = end - start + 1;
        let scanned = 0;
        let activeDevices = 0;
        
        this._updateStatus(`Scanning ${start}-${end} ... (0%)`);
        
        let scanGroup = (groupStart) => {
            if (groupStart > end) {
                this._updateStatus(`Found ${this._devices.length} devices`);
                this._scanning = false;
                this._scanButton.set_label('Scan');
                this._displayDevices();
                return;
            }
            
            let groupEnd = Math.min(groupStart + this._maxConcurrent - 1, end);
            let groupSize = groupEnd - groupStart + 1;
            let groupCompleted = 0;
            
            for (let i = groupStart; i <= groupEnd; i++) {
                let ip = `${base}.${i}`;
                
                if (ip === this._myIP) {
                    groupCompleted++;
                    scanned++;
                    if (groupCompleted >= groupSize) {
                        this._updateStatus(`Scanning ... (${Math.round((scanned/total)*100)}%)`);
                        scanGroup(groupEnd + 1);
                    }
                    continue;
                }
                
                this._checkSingleIP(ip, (isActive, deviceInfo) => {
                    groupCompleted++;
                    scanned++;
                    
                    if (isActive) {
                        activeDevices++;
                        this._devices.push(deviceInfo);
                    }
                    
                    if (scanned % 25 === 0 || scanned === total) {
                        this._updateStatus(`Scanning ... (${Math.round((scanned/total)*100)}%) - ${activeDevices} active`);
                    }
                    
                    if (groupCompleted >= groupSize) {
                        scanGroup(groupEnd + 1);
                    }
                });
            }
        };
        
        scanGroup(start);
    }
    
    _checkSingleIP(ip, callback) {
        this._pingWithTimeout(ip, 1000, (pingSuccess) => {
            if (!pingSuccess) {
                callback(false, null);
                return;
            }
            
            this._getMACFromARP(ip, (mac) => {
                if (!mac) {
                    callback(false, null);
                    return;
                }
                
                this._getFullDeviceInfo(ip, mac, false, (deviceInfo) => {
                    callback(true, deviceInfo);
                });
            });
        });
    }
    
    _pingWithTimeout(ip, timeoutMs, callback) {
        let completed = false;
        let timeoutId = null;
        
        try {
            let proc = Gio.Subprocess.new(
                ['ping', '-c', '1', '-W', '1', ip],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            
            proc.wait_async(this._cancellable, (proc, result) => {
                if (completed) return;
                completed = true;
                
                if (timeoutId) {
                    GLib.source_remove(timeoutId);
                    this._pendingTimeouts = (this._pendingTimeouts || []).filter(id => id !== timeoutId);
                }
                
                try {
                    proc.wait_finish(result);
                    callback(proc.get_successful());
                } catch (e) {
                    callback(false);
                }
            });
            
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                this._pendingTimeouts = (this._pendingTimeouts || []).filter(id => id !== timeoutId);
                if (!completed) {
                    completed = true;
                    try {
                        proc.force_exit();
                    } catch (e) {}
                    callback(false);
                }
                return GLib.SOURCE_REMOVE;
            });
            this._pendingTimeouts = (this._pendingTimeouts || []);
            this._pendingTimeouts.push(timeoutId);
            
        } catch (e) {
            callback(false);
        }
    }
    
    _getMACFromARP(ip, callback) {
        let tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._pendingTimeouts = (this._pendingTimeouts || []).filter(id => id !== tid);

            if (!this._cancellable || this._cancellable.is_cancelled()) {
                return GLib.SOURCE_REMOVE;
            }

            let proc = null;
            try {
                proc = Gio.Subprocess.new(
                    ['ip', 'neigh', 'show'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
            } catch (e) {}

            if (proc) {
                proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                    try {
                        let [, stdout] = proc.communicate_utf8_finish(res);
                        if (stdout) {
                            for (let line of stdout.split('\n')) {
                                if (line.includes(ip)) {
                                    let match = line.match(/lladdr\s+([\w:]+)/);
                                    if (match) {
                                        callback(match[1].toLowerCase());
                                        return;
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                    this._getMACFromARPFallback(ip, callback);
                });
            } else {
                this._getMACFromARPFallback(ip, callback);
            }

            return GLib.SOURCE_REMOVE;
        });
        this._pendingTimeouts = (this._pendingTimeouts || []);
        this._pendingTimeouts.push(tid);
    }

    _getMACFromARPFallback(ip, callback) {
        try {
            let proc = Gio.Subprocess.new(
                ['arp', '-n', ip],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) {
                        for (let line of stdout.split('\n')) {
                            if (line.includes(ip)) {
                                let match = line.match(/([\w:]{2}:[\w:]{2}:[\w:]{2}:[\w:]{2}:[\w:]{2}:[\w:]{2})/);
                                if (match) {
                                    callback(match[1].toLowerCase());
                                    return;
                                }
                            }
                        }
                    }
                } catch (e) {}
                callback(null);
            });
        } catch (e) {
            callback(null);
        }
    }
    
    _getFullDeviceInfo(ip, mac, isLocal, callback) {
        let deviceInfo = {
            ip: ip,
            mac: mac,
            hostname: null,
            os: null,
            vendor: null,
            isLocal: isLocal
        };
        
        let completed = 0;
        let totalTasks = 3;
        
        let checkCompletion = () => {
            completed++;
            if (completed >= totalTasks) {
                deviceInfo.type = this._determineDeviceType(deviceInfo);
                callback(deviceInfo);
            }
        };
        
        this._getHostnameMultipleMethods(ip, (hostname) => {
            deviceInfo.hostname = hostname;
            checkCompletion();
        });
        
        this._detectOS(ip, (osInfo) => {
            deviceInfo.os = osInfo;
            checkCompletion();
        });
        
        this._getVendorFromMAC(mac, (vendor) => {
            deviceInfo.vendor = vendor;
            checkCompletion();
        });
    }
    
    _getHostnameMultipleMethods(ip, callback) {
        let methodsTried = 0;
        
        let tryNextMethod = () => {
            methodsTried++;
            
            switch(methodsTried) {
                case 1:
                    this._getHostnameViaGetent(ip, (result) => {
                        if (result) {
                            callback(result);
                        } else {
                            tryNextMethod();
                        }
                    });
                    break;
                    
                case 2:
                    this._getHostnameViaNMBLookup(ip, (result) => {
                        if (result) {
                            callback(result);
                        } else {
                            tryNextMethod();
                        }
                    });
                    break;
                    
                case 3:
                    this._getHostnameViaAvahi(ip, (result) => {
                        if (result) {
                            callback(result);
                        } else {
                            tryNextMethod();
                        }
                    });
                    break;
                    
                case 4:
                    this._getHostnameViaDNS(ip, (result) => {
                        callback(result);
                    });
                    break;
            }
        };
        
        tryNextMethod();
    }
    
    _getHostnameViaGetent(ip, callback) {
        try {
            let proc = Gio.Subprocess.new(
                ['getent', 'hosts', ip],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) {
                        let output = stdout.trim();
                        let parts = output.split(/\s+/);
                        if (parts.length > 1 && parts[1] !== ip) {
                            let hostname = parts[1];
                            callback(hostname.endsWith('.local') ? hostname.replace('.local', '') : hostname);
                            return;
                        }
                    }
                } catch (e) {}
                callback(null);
            });
        } catch (e) {
            callback(null);
        }
    }
    
    _getHostnameViaNMBLookup(ip, callback) {
        try {
            let proc = Gio.Subprocess.new(
                ['timeout', '1', 'nmblookup', '-A', ip],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) {
                        for (let line of stdout.split('\n')) {
                            if (line.includes('<00>') && line.includes('UNIQUE')) {
                                let match = line.match(/\s+([^\s]+)\s+<00>/);
                                if (match && match[1] && match[1].length > 1) {
                                    callback(match[1]);
                                    return;
                                }
                            }
                        }
                    }
                } catch (e) {}
                callback(null);
            });
        } catch (e) {
            callback(null);
        }
    }
    
    _getHostnameViaAvahi(ip, callback) {
        try {
            let proc = Gio.Subprocess.new(
                ['avahi-resolve-address', ip],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) {
                        let output = stdout.trim();
                        if (output) {
                            let parts = output.split(/\t/);
                            if (parts.length > 1 && parts[1] && parts[1] !== ip) {
                                callback(parts[1].replace('.local', ''));
                                return;
                            }
                        }
                    }
                } catch (e) {}
                callback(null);
            });
        } catch (e) {
            callback(null);
        }
    }
    
    _getHostnameViaDNS(ip, callback) {
        try {
            let proc = Gio.Subprocess.new(
                ['dig', '+short', '-x', ip],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) {
                        let output = stdout.trim();
                        if (output && output.length > 0 && output !== ip) {
                            callback(output.replace(/\.$/, ''));
                            return;
                        }
                    }
                } catch (e) {}
                callback(null);
            });
        } catch (e) {
            callback(null);
        }
    }
    
    _detectOS(ip, callback) {
        let detectedOS = null;
        let portsToCheck = [22, 80, 443, 3389, 5353];
        let checksDone = 0;
        
        let checkPort = (portIndex) => {
            if (portIndex >= portsToCheck.length) {
                callback(detectedOS);
                return;
            }
            
            let port = portsToCheck[portIndex];
            
            try {
                let proc = Gio.Subprocess.new(
                    ['timeout', '0.5', 'nc', '-z', '-w', '0.3', ip, port.toString()],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                
                proc.wait_async(this._cancellable, (proc, result) => {
                    checksDone++;
                    
                    try {
                        proc.wait_finish(result);
                        if (proc.get_successful()) {
                            if (port === 22 && !detectedOS) detectedOS = 'Linux/Unix';
                            if (port === 3389 && !detectedOS) detectedOS = 'Windows';
                            if (port === 5353 && !detectedOS) detectedOS = 'Apple';
                        }
                    } catch (e) {
                        if (e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                            return;
                        }
                    }
                    
                    checkPort(portIndex + 1);
                });
                
            } catch (e) {
                checksDone++;
                checkPort(portIndex + 1);
            }
        };
        
        let proc = null;
        try {
            proc = Gio.Subprocess.new(
                ['/bin/sh', '-c', `ping -c 1 ${ip} 2>/dev/null | grep -o "ttl=[0-9]*"`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (e) {}

        if (proc) {
            proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) {
                        let ttlMatch = stdout.trim().match(/ttl=(\d+)/);
                        if (ttlMatch) {
                            let ttl = parseInt(ttlMatch[1]);
                            if (ttl <= 64 && !detectedOS) detectedOS = 'Linux/Unix';
                            if (ttl === 128 && !detectedOS) detectedOS = 'Windows';
                            if (ttl >= 255 && !detectedOS) detectedOS = 'Router/Switch';
                        }
                    }
                } catch (e) {}
                checkPort(0);
            });
        } else {
            checkPort(0);
        }
    }
    
    _getVendorFromMAC(mac, callback) {
        if (!mac) {
            callback(null);
            return;
        }
        
        let oui = mac.toLowerCase().substring(0, 8);
        
        let vendors = {
            '00:0c:29': 'VMware', '00:50:56': 'VMware',
            '00:15:5d': 'Microsoft', '00:1c:42': 'Parallels',
            '00:1a:11': 'Google', '00:26:bb': 'Apple',
            '30:ae:a4': 'Apple', 'ac:bc:32': 'Apple',
            'dc:a6:32': 'Raspberry Pi', 'b8:27:eb': 'Raspberry Pi',
            '00:1a:2b': 'ASUS', '00:1d:60': 'ASUS',
            '00:50:7f': 'ASUS', '00:0f:b0': 'LG',
            '00:1b:63': 'Samsung', '00:1d:25': 'Samsung',
            '00:1e:7d': 'Samsung', '00:26:e8': 'Huawei',
            '00:1e:10': 'Huawei', '00:25:9e': 'Cisco',
            '00:26:0b': 'Cisco', '00:18:b9': 'D-Link',
            '00:1c:f0': 'TP-Link', '00:21:27': 'TP-Link',
            '00:1e:8c': 'NETGEAR', '00:24:b2': 'NETGEAR',
            '00:1d:72': 'Intel', '00:13:ce': 'Intel',
            '00:16:6f': 'Intel', '00:19:d1': 'Intel',
            '28:80:23': 'Huawei', 'a0:57:e3': 'Huawei',
            '84:38:38': 'Huawei', '74:23:44': 'Huawei',
            '24:0a:c4': 'Espressif', '24:6f:28': 'Espressif',
            '24:62:ab': 'Espressif', '24:d7:eb': 'Espressif',
            '30:ae:a4': 'Espressif', '34:85:18': 'Espressif',
            '3c:61:05': 'Espressif', '3c:71:bf': 'Espressif',
            '40:22:d8': 'Espressif', '48:3f:da': 'Espressif',
            '4c:11:ae': 'Espressif', '54:43:b2': 'Espressif',
            '58:bf:25': 'Espressif', '5c:cf:7f': 'Espressif',
            '60:01:94': 'Espressif', '68:c6:3a': 'Espressif',
            '7c:9e:bd': 'Espressif', '7c:df:a1': 'Espressif',
            '84:cc:a8': 'Espressif', '84:f7:03': 'Espressif',
            '84:fc:e6': 'Espressif', '8c:aa:b5': 'Espressif',
            '90:38:0c': 'Espressif', '94:b9:7e': 'Espressif',
            '94:b5:55': 'Espressif', '98:cd:ac': 'Espressif',
            '98:f4:ab': 'Espressif', 'a0:20:a6': 'Espressif',
            'a0:76:4e': 'Espressif', 'a4:cf:12': 'Espressif',
            'a8:03:2a': 'Espressif', 'ac:0b:fb': 'Espressif',
            'ac:67:b2': 'Espressif', 'b4:8a:0a': 'Espressif',
            'b8:d6:1a': 'Espressif', 'bc:dd:c2': 'Espressif',
            'c4:4f:33': 'Espressif', 'c8:2b:96': 'Espressif',
            'c8:c9:a3': 'Espressif', 'cc:50:e3': 'Espressif',
            'd8:a0:1d': 'Espressif', 'd8:bf:c0': 'Espressif',
            'dc:54:75': 'Espressif', 'e0:98:06': 'Espressif',
            'e8:31:cd': 'Espressif', 'e8:68:e7': 'Espressif',
            'e8:db:84': 'Espressif', 'ec:64:c9': 'Espressif',
            'ec:fa:bc': 'Espressif', 'f0:08:d1': 'Espressif',
            'f4:cf:a2': 'Espressif', 'fc:f5:c4': 'Espressif'
        };
        
        callback(vendors[oui] || null);
    }
    
    _determineDeviceType(deviceInfo) {
        let hostname = (deviceInfo.hostname || '').toLowerCase();
        let vendor = (deviceInfo.vendor || '').toLowerCase();
        let os = (deviceInfo.os || '').toLowerCase();
        let mac = (deviceInfo.mac || '').toLowerCase();
        
        if (deviceInfo.isLocal) return 'this-pc';

        if (hostname.includes('esp32') || hostname.includes('esp8266') ||
            hostname.includes('espressif') || hostname.startsWith('esp-') ||
            hostname.includes('mpy-esp')) {
            return 'esp32';
        }
        if (hostname.includes('android') || hostname.includes('galaxy') || hostname.includes('sm-')) {
            return 'android';
        }
        if (hostname.includes('iphone') || hostname.includes('ipad') || hostname.includes('apple')) {
            return 'apple';
        }
        if (hostname.includes('fedora') || hostname.includes('ubuntu') || hostname.includes('debian') || 
            hostname.includes('arch') || hostname.includes('raspbian')) {
            return 'linux';
        }
        if (hostname.includes('windows') || hostname.includes('win-')) {
            return 'windows';
        }
        if (hostname.includes('router') || hostname.includes('asus') || hostname.includes('tplink') || 
            hostname.includes('netgear') || hostname.includes('dlink')) {
            return 'router';
        }
        if (hostname.includes('tv') || hostname.includes('samsung') || hostname.includes('lg') || 
            hostname.includes('philips') || hostname.includes('sony')) {
            return 'tv';
        }
        if (hostname.includes('nas') || hostname.includes('synology') || hostname.includes('qnap')) {
            return 'nas';
        }
        if (hostname.includes('printer') || hostname.includes('hp') || hostname.includes('epson')) {
            return 'printer';
        }
        
        if (os.includes('linux') || os.includes('unix')) return 'linux';
        if (os.includes('windows')) return 'windows';
        if (os.includes('apple')) return 'apple';
        
        if (vendor.includes('apple')) return 'apple';
        if (vendor.includes('espressif')) return 'esp32';
        if (vendor.includes('samsung')) return 'android';
        if (vendor.includes('huawei')) return vendor.includes('router') ? 'router' : 'android';
        if (vendor.includes('raspberry')) return 'linux';
        if (vendor.includes('vmware') || vendor.includes('parallels')) return 'vm';
        if (vendor.includes('cisco') || vendor.includes('d-link') || vendor.includes('tp-link')) return 'router';
        
        if (mac.startsWith('00:0c:29') || mac.startsWith('00:50:56')) return 'vm';
        if (mac.startsWith('dc:a6:32') || mac.startsWith('b8:27:eb')) return 'linux';
        
        return 'generic';
    }
    
    _getMyMacAddress(callback) {
        try {
            let proc = Gio.Subprocess.new(
                ['ip', 'link', 'show'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) {
                        let lines = stdout.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].includes('state UP') && !lines[i].includes('lo:')) {
                                if (i + 1 < lines.length) {
                                    let match = lines[i + 1].match(/link\/ether ([\w:]+)/);
                                    if (match) {
                                        callback(match[1]);
                                        return;
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {}
                callback(null);
            });
        } catch (e) {
            callback(null);
        }
    }
    
    _displayDevices() {
        this._resultsBox.destroy_all_children();
        
        if (this._devices.length === 0) {
            let empty = new St.Label({
                text: 'No devices found.',
                style: 'padding: 10px;'
            });
            this._resultsBox.add_child(empty);
            this._setSubtitle('0');
            return;
        }
        
        this._devices.sort((a, b) => {
            let aNum = parseInt(a.ip.split('.')[3]);
            let bNum = parseInt(b.ip.split('.')[3]);
            return aNum - bNum;
        });
        
        let mainBox = new St.BoxLayout({
            vertical: true,
            style: 'padding: 10px;'
        });
        
        let leftColumn = [];
        let rightColumn = [];
        
        for (let i = 0; i < this._devices.length; i++) {
            if (i % 2 === 0) {
                leftColumn.push(this._devices[i]);
            } else {
                rightColumn.push(this._devices[i]);
            }
        }
        
        let maxRows = Math.max(leftColumn.length, rightColumn.length);
        
        for (let i = 0; i < maxRows; i++) {
            let rowBox = new St.BoxLayout({
                style: 'spacing: 15px; padding: 5px 0;'
            });
            
            if (i < leftColumn.length) {
                let deviceBox = this._createDeviceBox(leftColumn[i]);
                rowBox.add_child(deviceBox);
            } else {
                let emptyBox = new St.BoxLayout({
                    style: 'width: 280px;'
                });
                rowBox.add_child(emptyBox);
            }
            
            if (i < rightColumn.length) {
                let deviceBox = this._createDeviceBox(rightColumn[i]);
                rowBox.add_child(deviceBox);
            }
            
            mainBox.add_child(rowBox);
        }
        
        this._resultsBox.add_child(mainBox);
        
        this._setSubtitle(this._devices.length.toString());
    }
    
    _createDeviceBox(device) {
        let icons = {
            'this-pc': '💻', 'android': '📱', 'apple': '📱', 'linux': '🐧',
            'windows': '🪟', 'router': '📡', 'vm': '☁️', 'tv': '📺',
            'nas': '💾', 'printer': '🖨️', 'generic': '🖥️',
            'esp32': '🔌'
        };
        
        let icon = icons[device.type] || '🖥️';
        let bgColor = device.isLocal ? 'rgba(0,200,0,0.1)' : 'rgba(255,255,255,0.05)';
        let borderColor = device.isLocal ? 'rgba(0,200,0,0.3)' : 'rgba(255,255,255,0.1)';
        
        let hostnameDisplay = device.hostname || 'Unknown';
        let osDisplay = device.os ? `OS: ${device.os}` : '';
        let vendorDisplay = device.vendor ? `${device.vendor}` : '';
        
        let box = new St.BoxLayout({
            vertical: true,
            style: `padding: 10px; 
                    background-color: ${bgColor}; 
                    border-radius: 8px; 
                    border: 1px solid ${borderColor}; 
                    width: 280px; 
                    min-height: 80px;`
        });
        
        let topBox = new St.BoxLayout({
            style: 'spacing: 8px; margin-bottom: 5px;'
        });
        
        let iconLabel = new St.Label({
            text: icon,
            style: 'font-size: 1.1em; min-width: 24px;'
        });
        
        let ipBox = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 2px;'
        });
        
        let ipLabel = new St.Label({
            text: device.ip,
            style: 'font-weight: bold; font-size: 0.95em;'
        });
        
        
        ipBox.add_child(ipLabel);
        
        topBox.add_child(iconLabel);
        topBox.add_child(ipBox);
        box.add_child(topBox);
        
        let macLabel = new St.Label({
            text: `🔗 ${device.mac}`,
            style: 'font-size: 0.8em; color: #888; margin: 2px 0;'
        });
        box.add_child(macLabel);
        
        let hostnameLabel = new St.Label({
            text: `🏷️  ${this._truncateText(hostnameDisplay, 24)}`,
            style: 'font-size: 0.85em; margin: 2px 0;'
        });
        box.add_child(hostnameLabel);
        
        if (osDisplay || vendorDisplay) {
            let infoBox = new St.BoxLayout({
                style: 'spacing: 10px; margin-top: 5px; padding-top: 5px; border-top: 1px solid rgba(255,255,255,0.1);'
            });
            
            if (osDisplay) {
                let osLabel = new St.Label({
                    text: `🖥️  ${this._truncateText(device.os, 12)}`,
                    style: 'font-size: 0.75em; color: #666;'
                });
                infoBox.add_child(osLabel);
            }
            
            if (vendorDisplay) {
                let vendorLabel = new St.Label({
                    text: `🏭  ${this._truncateText(vendorDisplay, 14)}`,
                    style: 'font-size: 0.75em; color: #666;'
                });
                infoBox.add_child(vendorLabel);
            }
            
            box.add_child(infoBox);
        }
        
        return box;
    }
    
    _truncateText(text, maxLength) {
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    }
    
    _updateStatus(text) {
        if (this._statusLabel)
            this._statusLabel.set_text(text);
    }
    
    destroy() {
        if (this._dragMotionId) {
            global.stage.disconnect(this._dragMotionId);
            this._dragMotionId = null;
        }
        if (this._dragReleaseId) {
            global.stage.disconnect(this._dragReleaseId);
            this._dragReleaseId = null;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._pendingTimeouts) {
            this._pendingTimeouts.forEach(id => GLib.source_remove(id));
            this._pendingTimeouts = [];
        }
        super.destroy();
    }
});

const LANScanner = GObject.registerClass(
class LANScanner extends QuickSettings.QuickToggle {
    _init() {
        super._init({
            title: 'LAN Scanner',
            subtitle: '0',
            iconName: 'network-workgroup-symbolic',
            toggleMode: false,
        });

        this._window = new LanWindow((subtitle) => {
            this.subtitle = subtitle;
        });
        this._window._onOpenChange = (isOpen) => {
            this.checked = isOpen;
        };

        this.connect('clicked', () => this._window.toggle());
    }

    destroy() {
        if (this._window) {
            this._window.destroy();
            this._window = null;
        }
        super.destroy();
    }
});

const LANScannerIndicator = GObject.registerClass(
class LANScannerIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();
        this._toggle = new LANScanner();
        this.quickSettingsItems.push(this._toggle);
    }

    destroy() {
        this._toggle.destroy();
        super.destroy();
    }
});

export default class LANScannerExtension extends Extension {
    enable() {
        this._indicator = new LANScannerIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
