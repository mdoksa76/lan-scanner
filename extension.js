import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const LANScanner = GObject.registerClass(
class LANScanner extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'LAN Scanner Pro');
        
        this._devices = [];
        this._scanning = false;
        this._subnet = null;
        this._myIP = null;
        this._myMac = null;
        this._activePings = 0;
        this._maxConcurrent = 50;
        
        // Ikona i label
        let box = new St.BoxLayout();
        this._icon = new St.Icon({
            icon_name: 'network-workgroup-symbolic',
            style_class: 'system-status-icon'
        });
        this._label = new St.Label({
            text: '0',
            y_align: Clutter.ActorAlign.CENTER
        });
        
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);
        
        this._createHeader();
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._statusItem = new PopupMenu.PopupMenuItem('Click "Scan" for start', {
            reactive: false
        });
        this.menu.addMenuItem(this._statusItem);
        
        this._detectSubnet();
    }
    
    _createHeader() {
        let headerBox = new St.BoxLayout({
            vertical: true,
            style_class: 'lan-scanner-header'
        });
        
        let subnetBox = new St.BoxLayout({
            style: 'spacing: 10px; padding: 10px;'
        });
        
        let subnetLabel = new St.Label({
            text: 'Subnet:',
            y_align: Clutter.ActorAlign.CENTER
        });
        
        this._subnetEntry = new St.Entry({
            hint_text: '192.168.1.0/24',
            can_focus: true,
            track_hover: true,
            style: 'width: 150px;'
        });
        
        subnetBox.add_child(subnetLabel);
        subnetBox.add_child(this._subnetEntry);
        
        let buttonBox = new St.BoxLayout({
            style: 'spacing: 5px; padding: 5px 10px;'
        });
        
        this._scanButton = new St.Button({
            label: 'Scan',
            style_class: 'button'
        });
        this._scanButton.connect('clicked', () => this._startScan());
        
        this._detectButton = new St.Button({
            label: 'Auto',
            style_class: 'button'
        });
        this._detectButton.connect('clicked', () => this._detectSubnet());
        
        buttonBox.add_child(this._scanButton);
        buttonBox.add_child(this._detectButton);
        
        headerBox.add_child(subnetBox);
        headerBox.add_child(buttonBox);
        
        let headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }
    
    _detectSubnet() {
        try {
            let [ok, out] = GLib.spawn_command_line_sync('ip -4 addr show');
            if (ok) {
                let output = new TextDecoder().decode(out);
                let lines = output.split('\n');
                for (let line of lines) {
                    let match = line.match(/inet ([\d.]+)\/(\d+)/);
                    if (match && !match[1].startsWith('127.')) {
                        this._myIP = match[1];
                        let cidr = match[2];
                        let parts = this._myIP.split('.');
                        this._subnet = `${parts[0]}.${parts[1]}.${parts[2]}.0/${cidr}`;
                        this._subnetEntry.set_text(this._subnet);
                        this._updateStatus(`Detected subnet: ${this._subnet}`);
                        this._myMac = this._getMyMacAddress();
                        return;
                    }
                }
            }
        } catch (e) {
            log(`Greška pri detekciji: ${e}`);
        }
        
        this._subnet = '192.168.1.0/24';
        this._subnetEntry.set_text(this._subnet);
        this._updateStatus('Use default subnet');
        this._myMac = this._getMyMacAddress();
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
        this._deviceSection.removeAll();
        this._scanButton.set_label('Scanning ...');
        this._updateStatus('Start scanning ...');
        this._label.set_text('...');
        
        let [baseIP, mask] = subnet.split('/');
        let parts = baseIP.split('.');
        let base = `${parts[0]}.${parts[1]}.${parts[2]}`;
        
        // Dodaj svoj uređaj odmah
        if (this._myIP && this._myMac) {
            this._getFullDeviceInfo(this._myIP, this._myMac, true, (deviceInfo) => {
                this._devices.push(deviceInfo);
            });
        }
        
        // Počni skeniranje svih IP-ova
        this._scanIPRange(base, 1, 254);
    }
    
    _scanIPRange(base, start, end) {
        let total = end - start + 1;
        let scanned = 0;
        let activeDevices = 0;
        
        this._updateStatus(`Scanning ${start}-${end} ... (0%)`);
        
        // Paralelno skeniraj IP-ove u grupama
        let scanGroup = (groupStart) => {
            if (groupStart > end) {
                // Svi skenirani
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
                
                // Preskoči svoj IP
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
                    
                    // Ažuriraj status
                    if (scanned % 25 === 0 || scanned === total) {
                        this._updateStatus(`Scanning ... (${Math.round((scanned/total)*100)}%) - ${activeDevices} active`);
                    }
                    
                    // Kada je grupa gotova, nastavi sa sljedećom
                    if (groupCompleted >= groupSize) {
                        scanGroup(groupEnd + 1);
                    }
                });
            }
        };
        
        // Počni sa prvom grupom
        scanGroup(start);
    }
    
    _checkSingleIP(ip, callback) {
        // 1. Prvo ping da provjerimo je li uređaj živ
        this._pingWithTimeout(ip, 1000, (pingSuccess) => {
            if (!pingSuccess) {
                callback(false, null);
                return;
            }
            
            // 2. Dobavi MAC adresu iz ARP tablice
            this._getMACFromARP(ip, (mac) => {
                if (!mac) {
                    callback(false, null);
                    return;
                }
                
                // 3. Dobavi potpune informacije o uređaju
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
            
            proc.wait_async(null, (proc, result) => {
                if (completed) return;
                completed = true;
                
                if (timeoutId) {
                    GLib.source_remove(timeoutId);
                }
                
                try {
                    callback(proc.get_successful());
                } catch (e) {
                    callback(false);
                }
            });
            
            // Timeout za svaki slučaj
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                if (!completed) {
                    completed = true;
                    try {
                        proc.force_exit();
                    } catch (e) {}
                    callback(false);
                }
                return GLib.SOURCE_REMOVE;
            });
            
        } catch (e) {
            callback(false);
        }
    }
    
    _getMACFromARP(ip, callback) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            try {
                let [ok, out] = GLib.spawn_command_line_sync('ip neigh show');
                if (ok) {
                    let output = new TextDecoder().decode(out);
                    let lines = output.split('\n');
                    
                    for (let line of lines) {
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
            
            try {
                let [ok, out] = GLib.spawn_command_line_sync(`arp -n ${ip}`);
                if (ok) {
                    let output = new TextDecoder().decode(out);
                    let lines = output.split('\n');
                    
                    for (let line of lines) {
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
            return GLib.SOURCE_REMOVE;
        });
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
        
        // 1. Hostname (više metoda)
        this._getHostnameMultipleMethods(ip, (hostname) => {
            deviceInfo.hostname = hostname;
            checkCompletion();
        });
        
        // 2. OS detekcija
        this._detectOS(ip, (osInfo) => {
            deviceInfo.os = osInfo;
            checkCompletion();
        });
        
        // 3. Vendor iz MAC OUI
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
            let [ok, out] = GLib.spawn_command_line_sync(`getent hosts ${ip}`);
            if (ok) {
                let output = new TextDecoder().decode(out).trim();
                let parts = output.split(/\s+/);
                if (parts.length > 1 && parts[1] !== ip) {
                    let hostname = parts[1];
                    callback(hostname.endsWith('.local') ? hostname.replace('.local', '') : hostname);
                    return;
                }
            }
        } catch (e) {}
        callback(null);
    }
    
    _getHostnameViaNMBLookup(ip, callback) {
        try {
            let [ok, out] = GLib.spawn_command_line_sync(`timeout 1 nmblookup -A ${ip} 2>/dev/null`);
            if (ok) {
                let output = new TextDecoder().decode(out);
                let lines = output.split('\n');
                for (let line of lines) {
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
    }
    
    _getHostnameViaAvahi(ip, callback) {
        try {
            let [ok, out] = GLib.spawn_command_line_sync(`avahi-resolve-address ${ip} 2>/dev/null`);
            if (ok) {
                let output = new TextDecoder().decode(out).trim();
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
    }
    
    _getHostnameViaDNS(ip, callback) {
        try {
            let [ok, out] = GLib.spawn_command_line_sync(`dig +short -x ${ip} 2>/dev/null`);
            if (ok) {
                let output = new TextDecoder().decode(out).trim();
                if (output && output.length > 0 && output !== ip) {
                    callback(output.replace(/\.$/, ''));
                    return;
                }
            }
        } catch (e) {}
        callback(null);
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
                
                proc.wait_async(null, (proc, result) => {
                    checksDone++;
                    
                    try {
                        if (proc.get_successful()) {
                            if (port === 22 && !detectedOS) detectedOS = 'Linux/Unix';
                            if (port === 3389 && !detectedOS) detectedOS = 'Windows';
                            if (port === 5353 && !detectedOS) detectedOS = 'Apple';
                        }
                    } catch (e) {}
                    
                    checkPort(portIndex + 1);
                });
                
            } catch (e) {
                checksDone++;
                checkPort(portIndex + 1);
            }
        };
        
        // Provjeri TTL iz ping odgovora
        try {
            let [ok, out] = GLib.spawn_command_line_sync(`ping -c 1 ${ip} 2>/dev/null | grep -o "ttl=\\d+"`);
            if (ok) {
                let output = new TextDecoder().decode(out).trim();
                let ttlMatch = output.match(/ttl=(\d+)/);
                if (ttlMatch) {
                    let ttl = parseInt(ttlMatch[1]);
                    if (ttl <= 64 && !detectedOS) detectedOS = 'Linux/Unix';
                    if (ttl === 128 && !detectedOS) detectedOS = 'Windows';
                    if (ttl >= 255 && !detectedOS) detectedOS = 'Router/Switch';
                }
            }
        } catch (e) {}
        
        checkPort(0);
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
            '84:38:38': 'Huawei', '74:23:44': 'Huawei'
        };
        
        callback(vendors[oui] || null);
    }
    
    _determineDeviceType(deviceInfo) {
        let hostname = (deviceInfo.hostname || '').toLowerCase();
        let vendor = (deviceInfo.vendor || '').toLowerCase();
        let os = (deviceInfo.os || '').toLowerCase();
        let mac = (deviceInfo.mac || '').toLowerCase();
        
        if (deviceInfo.isLocal) return 'this-pc';
        
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
        if (vendor.includes('samsung')) return 'android';
        if (vendor.includes('huawei')) return vendor.includes('router') ? 'router' : 'android';
        if (vendor.includes('raspberry')) return 'linux';
        if (vendor.includes('vmware') || vendor.includes('parallels')) return 'vm';
        if (vendor.includes('cisco') || vendor.includes('d-link') || vendor.includes('tp-link')) return 'router';
        
        if (mac.startsWith('00:0c:29') || mac.startsWith('00:50:56')) return 'vm';
        if (mac.startsWith('dc:a6:32') || mac.startsWith('b8:27:eb')) return 'linux';
        
        return 'generic';
    }
    
    _getMyMacAddress() {
        try {
            let [ok, out] = GLib.spawn_command_line_sync('ip link show');
            if (ok) {
                let output = new TextDecoder().decode(out);
                let lines = output.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes('state UP') && !lines[i].includes('lo:')) {
                        if (i + 1 < lines.length) {
                            let match = lines[i + 1].match(/link\/ether ([\w:]+)/);
                            if (match) return match[1];
                        }
                    }
                }
            }
        } catch (e) {}
        return null;
    }
    
    _displayDevices() {
        this._deviceSection.removeAll();
        
        if (this._devices.length === 0) {
            let item = new PopupMenu.PopupMenuItem('“No devices found.', {
                reactive: false
            });
            this._deviceSection.addMenuItem(item);
            this._label.set_text('0');
            return;
        }
        
        // Sortiraj po IP
        this._devices.sort((a, b) => {
            let aNum = parseInt(a.ip.split('.')[3]);
            let bNum = parseInt(b.ip.split('.')[3]);
            return aNum - bNum;
        });
        
        // Kreiraj scrollable kontejner
        let scrollView = new St.ScrollView({
            style: 'max-height: 600px; min-width: 600px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC
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
            
            // Lijevi stupac
            if (i < leftColumn.length) {
                let deviceBox = this._createDeviceBox(leftColumn[i]);
                rowBox.add_child(deviceBox);
            } else {
                // Prazan prostor ako nema uređaja
                let emptyBox = new St.BoxLayout({
                    style: 'width: 280px;'
                });
                rowBox.add_child(emptyBox);
            }
            
            // Desni stupac
            if (i < rightColumn.length) {
                let deviceBox = this._createDeviceBox(rightColumn[i]);
                rowBox.add_child(deviceBox);
            }
            
            mainBox.add_child(rowBox);
        }
        
        scrollView.set_child(mainBox);
        
        let scrollItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        scrollItem.add_child(scrollView);
        this._deviceSection.addMenuItem(scrollItem);
        
        this._label.set_text(this._devices.length.toString());
    }
    
    _createDeviceBox(device) {
        let icons = {
            'this-pc': '💻', 'android': '📱', 'apple': '📱', 'linux': '🐧',
            'windows': '🪟', 'router': '📡', 'vm': '☁️', 'tv': '📺',
            'nas': '💾', 'printer': '🖨️', 'generic': '🖥️'
        };
        
        let icon = icons[device.type] || '🖥️';
        let bgColor = device.isLocal ? 'rgba(0,200,0,0.1)' : 'rgba(255,255,255,0.05)';
        let borderColor = device.isLocal ? 'rgba(0,200,0,0.3)' : 'rgba(255,255,255,0.1)';
        
        // Formatiraj prikaz
        let hostnameDisplay = device.hostname || 'Unknown';
        let osDisplay = device.os ? `OS: ${device.os}` : '';
        let vendorDisplay = device.vendor ? `${device.vendor}` : '';
        
        // Kreiraj box s fiksnim širinom za 2 stupca
        let box = new St.BoxLayout({
            vertical: true,
            style: `padding: 10px; 
                    background-color: ${bgColor}; 
                    border-radius: 8px; 
                    border: 1px solid ${borderColor}; 
                    width: 280px; 
                    min-height: 80px;`
        });
        
        // Gornji red: IP i ikona
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
        
        //if (device.isLocal) {
        //    let localLabel = new St.Label({
        //        text: device.ip,
        //        style: 'font-size: 0.8em; color: #00aa00;'
        //    });
        //    ipBox.add_child(localLabel);
        //}
        
        ipBox.add_child(ipLabel);
        
        topBox.add_child(iconLabel);
        topBox.add_child(ipBox);
        box.add_child(topBox);
        
        // MAC adresa (kompaktno)
        let macLabel = new St.Label({
            text: `🔗 ${device.mac}`,
            style: 'font-size: 0.8em; color: #888; margin: 2px 0;'
        });
        box.add_child(macLabel);
        
        // Hostname
        let hostnameLabel = new St.Label({
            text: `🏷️  ${this._truncateText(hostnameDisplay, 24)}`,
            style: 'font-size: 0.85em; margin: 2px 0;'
        });
        box.add_child(hostnameLabel);
        
        // Donji red: OS i Vendor (kompaktno)
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
    
    // Pomoćna metoda za skraćivanje dugih teksta
    _truncateText(text, maxLength) {
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    }
    
    _updateStatus(text) {
        this._statusItem.label.set_text(text);
    }
    
    destroy() {
        super.destroy();
    }
});

export default class LANScannerExtension extends Extension {
    enable() {
        this._indicator = new LANScanner();
        Main.panel.addToStatusArea('lan-scanner', this._indicator);
    }
    
    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}