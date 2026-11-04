(() => {
  const MAGIC = [0x56, 0x45, 0x49, 0x4c]; // VEIL
  const HEADER_BYTES = 8;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  const $ = (id) => document.getElementById(id);
  const state = { encode: null, decode: null, toastTimer: null };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function prettyBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function capacityFor(width, height) {
    return Math.max(0, Math.floor((width * height * 3 - HEADER_BYTES * 8) / 8));
  }

  function refreshCapacity() {
    const item = state.encode;
    const messageBytes = encoder.encode($('message').value).length;
    const label = $('capacity-label');
    const fill = $('capacity-fill');
    const hint = $('capacity-hint');
    const button = $('hide-button');
    $('char-count').textContent = `${$('message').value.length.toLocaleString()} / 10,000`;

    if (!item) {
      label.textContent = 'Choose an image first';
      fill.style.width = '0%';
      hint.textContent = 'A larger image can hold a longer note.';
      button.disabled = true;
      return;
    }
    const capacity = capacityFor(item.width, item.height);
    const percent = capacity ? Math.min(100, (messageBytes / capacity) * 100) : 100;
    label.textContent = `${prettyBytes(messageBytes)} / ${prettyBytes(capacity)}`;
    fill.style.width = `${percent}%`;
    const fits = messageBytes > 0 && messageBytes <= capacity;
    hint.textContent = messageBytes > capacity
      ? 'This message is too large for the selected image. Try a larger image or a shorter note.'
      : `${prettyBytes(capacity - messageBytes)} available`;
    button.disabled = !fits;
  }

  function imageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({ image, url });
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be opened.')); };
      image.src = url;
    });
  }

  async function acceptImage(file, mode) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Choose an image file to continue.'); return; }
    if (file.size > MAX_FILE_BYTES) { showToast('That image is over the 25 MB limit.'); return; }
    try {
      const { image, url } = await imageFromFile(file);
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('That image has no readable pixels.');
      if (state[mode]?.url) URL.revokeObjectURL(state[mode].url);
      state[mode] = { file, image, url, width: image.naturalWidth, height: image.naturalHeight };
      $(`${mode}-preview`).src = url;
      $(`${mode}-empty`).classList.add('hidden');
      $(`${mode}-preview-wrap`).classList.remove('hidden');
      $(`${mode}-meta`).classList.remove('hidden');
      $(`${mode}-name`).textContent = file.name;
      $(`${mode}-dimensions`).textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${prettyBytes(file.size)}`;
      if (mode === 'encode') refreshCapacity();
      else $('reveal-button').disabled = false;
    } catch (error) {
      showToast(error.message || 'Could not open that image.');
    }
  }

  function connectDropzone(zoneId, inputId, mode) {
    const zone = $(zoneId);
    const input = $(inputId);
    input.addEventListener('change', () => {
      acceptImage(input.files?.[0], mode);
      input.value = '';
    });
    zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
      acceptImage(event.dataTransfer?.files?.[0], mode);
    });
  }

  function setMode(mode) {
    const encode = mode === 'encode';
    $('encode-panel').classList.toggle('hidden', !encode);
    $('decode-panel').classList.toggle('hidden', encode);
    $('encode-tab').classList.toggle('active', encode);
    $('decode-tab').classList.toggle('active', !encode);
    $('encode-tab').setAttribute('aria-selected', String(encode));
    $('decode-tab').setAttribute('aria-selected', String(!encode));
    document.querySelector('.tab-indicator').classList.toggle('decode', !encode);
  }

  function readByte(data, startBit) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) {
      const channelIndex = startBit + bit;
      const pixel = Math.floor(channelIndex / 3);
      const channel = channelIndex % 3;
      value = (value << 1) | (data[pixel * 4 + channel] & 1);
    }
    return value;
  }

  function bytesToBits(bytes) {
    const bits = new Uint8Array(bytes.length * 8);
    let i = 0;
    for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) bits[i++] = (byte >> bit) & 1;
    return bits;
  }

  async function encodeMessage() {
    const item = state.encode;
    const payload = encoder.encode($('message').value);
    if (!item || payload.length === 0) return;
    const capacity = capacityFor(item.width, item.height);
    if (payload.length > capacity) { showToast('The message does not fit in this image.'); return; }

    canvas.width = item.width;
    canvas.height = item.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(item.image, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const header = new Uint8Array(HEADER_BYTES);
    header.set(MAGIC);
    new DataView(header.buffer).setUint32(4, payload.length, false);
    const bits = bytesToBits(new Uint8Array([...header, ...payload]));
    let bitIndex = 0;
    for (let pixel = 0; pixel < imageData.data.length && bitIndex < bits.length; pixel += 4) {
      for (let channel = 0; channel < 3 && bitIndex < bits.length; channel++) {
        const index = pixel + channel;
        imageData.data[index] = (imageData.data[index] & 0xfe) | bits[bitIndex++];
      }
    }
    ctx.putImageData(imageData, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) { showToast('Could not create the PNG. Try another image.'); return; }
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const baseName = item.file.name.replace(/\.[^.]+$/, '') || 'veil-image';
      link.href = downloadUrl;
      link.download = `${baseName}-veil.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      showToast('Your message is tucked away. PNG downloaded.');
    }, 'image/png');
  }

  function decodeMessage() {
    const item = state.decode;
    if (!item) return;
    try {
      canvas.width = item.width;
      canvas.height = item.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(item.image, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const channelCount = item.width * item.height * 3;
      if (channelCount < HEADER_BYTES * 8) throw new Error('This image is too small to contain a Veil message.');
      const header = new Uint8Array(HEADER_BYTES);
      for (let byte = 0; byte < HEADER_BYTES; byte++) header[byte] = readByte(data, byte * 8);
      if (!MAGIC.every((value, index) => header[index] === value)) throw new Error('No Veil message found in this image.');
      const length = new DataView(header.buffer).getUint32(4, false);
      if (length === 0 || length > capacityFor(item.width, item.height)) throw new Error('The hidden message appears incomplete or damaged.');
      const payload = new Uint8Array(length);
      const startBit = HEADER_BYTES * 8;
      for (let bit = 0; bit < length * 8; bit++) {
        const channelIndex = startBit + bit;
        const pixel = Math.floor(channelIndex / 3);
        const channel = channelIndex % 3;
        const value = (data[pixel * 4 + channel] & 1);
        payload[Math.floor(bit / 8)] = (payload[Math.floor(bit / 8)] << 1) | value;
      }
      const message = decoder.decode(payload);
      $('revealed-text').textContent = message;
      $('result-empty').classList.add('hidden');
      $('result-message').classList.remove('hidden');
      showToast('Hidden message revealed.');
    } catch (error) {
      $('result-message').classList.add('hidden');
      $('result-empty').classList.remove('hidden');
      $('result-empty').querySelector('strong').textContent = error.message || 'Could not read this image.';
      $('result-empty').querySelector('span').textContent = 'Try a PNG downloaded directly from Veil.';
      showToast(error.message || 'Could not read this image.');
    }
  }

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
  connectDropzone('encode-dropzone', 'encode-file', 'encode');
  connectDropzone('decode-dropzone', 'decode-file', 'decode');
  $('message').addEventListener('input', refreshCapacity);
  $('hide-button').addEventListener('click', encodeMessage);
  $('reveal-button').addEventListener('click', decodeMessage);
  $('copy-button').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('revealed-text').textContent); showToast('Message copied to clipboard.'); }
    catch { showToast('Clipboard access is unavailable in this browser.'); }
  });
  refreshCapacity();
})();

