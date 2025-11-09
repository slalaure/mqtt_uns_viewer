/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Formats a timestamp for display in slider labels.
 * @param {number} timestamp - The millisecond timestamp.
 * @returns {string} Formatted date/time string (e.g., "14:30:05 28/10/25").
 */
export function formatTimestampForLabel(timestamp) {
    const date = new Date(timestamp);
    const timePart = date.toLocaleTimeString('en-GB');
    const datePart = date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
    return `${timePart} ${datePart}`;
}

/**
 * Highlights a search term within a block of text.
 * @param {string} text - The text to search within.
 * @param {string} term - The search term to highlight.
 * @returns {string} The text as an HTML string with <mark> tags.
 */
export function highlightText(text, term) {
    if (!term) return text;
    // Escape special regex characters in the search term
    const regex = new RegExp(term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
    return text.replace(regex, `<mark class="highlight">$&</mark>`);
}

/**
 * Converts an MQTT pattern to a RegExp for simple client-side matching.
 * Note: This is a simplified version.
 * @param {string} pattern - The MQTT topic pattern (e.g., "a/+/c").
 * @returns {RegExp} A regular expression object.
 */
export function mqttPatternToClientRegex(pattern) {
    const regexString = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
        .replace(/\+/g, '[^/]+') // '+' matches one level segment
        .replace(/#/g, '.*'); // '#' matches zero or more levels at the end
    return new RegExp(`^${regexString}$`);
}

/**
 * Converts an MQTT topic pattern to a full RegExp.
 * Handles '+' and '#' wildcards more robustly.
 * @param {string} pattern - The MQTT topic pattern (e.g., "a/#").
 * @returns {RegExp} A regular expression object.
 */
export function mqttPatternToRegex(pattern) {
    // Escape characters with special meaning in regex, except for '+' and '#'
    const escapedPattern = pattern.replace(/[.^$*?()[\]{}|\\]/g, '\\$&');
    // Convert MQTT wildcards to regex equivalents
    const regexString = escapedPattern
        .replace(/\+/g, '[^/]+')       // '+' matches one level
        .replace(/#/g, '.*');          // '#' matches multiple levels (including zero)
    // Anchor the pattern to match the whole topic string
    return new RegExp(`^${regexString}$`);
}


/**
 * Makes a panel resizable, now with touch support.
 * @param {object} options
 * @param {HTMLElement} options.resizerEl - The drag handle element.
 * @param {string} options.direction - 'vertical' or 'horizontal'.
 * @param {HTMLElement} options.panelA - The panel to resize (left or top).
 * @param {HTMLElement} options.containerEl - (For horizontal) The parent container.
 */
export function makeResizable(options) {
    const { resizerEl, direction, panelA, containerEl } = options;
    if (!resizerEl || !panelA) return;

    const onDragMove = (ev) => {
        // Get coordinates for both mouse and touch events
        const pageX = ev.pageX ?? ev.touches?.[0]?.pageX;
        const pageY = ev.pageY ?? ev.touches?.[0]?.pageY;

        // If no coordinates (e.g., touch end), just return
        if (pageX === undefined || pageY === undefined) return;

        // Prevent default touch behavior (like scrolling) while dragging
        if (ev.touches) {
            ev.preventDefault();
        }

        if (direction === 'vertical') {
            const minWidth = 200;
            const containerRect = panelA.parentElement.getBoundingClientRect();
            let panelWidth = pageX - panelA.getBoundingClientRect().left;

            if (panelWidth < minWidth) panelWidth = minWidth;
            if (containerRect.width - panelWidth < minWidth) {
                panelWidth = containerRect.width - minWidth;
            }
            panelA.style.flexBasis = `${panelWidth}px`;
            
        } else if (direction === 'horizontal' && containerEl) {
            const minHeight = 100;
            const containerRect = containerEl.getBoundingClientRect();
            let panelHeight = pageY - containerRect.top;

            if (panelHeight < minHeight) panelHeight = minHeight;
            if (containerRect.height - panelHeight < minHeight) {
                panelHeight = containerRect.height - minHeight;
            }
            panelA.style.flexBasis = `${panelHeight}px`;
        }
    };
    
    const onDragEnd = () => {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        document.removeEventListener('touchmove', onDragMove);
        document.removeEventListener('touchend', onDragEnd);
        document.removeEventListener('touchcancel', onDragEnd);
    };

    const onDragStart = (e) => {
        // Prevent default on mousedown (e.g., text selection)
        // and on touchstart (e.g., page scrolling)
        e.preventDefault(); 
        
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd, { once: true });
        document.addEventListener('touchmove', onDragMove, { passive: false }); // passive: false to allow preventDefault
        document.addEventListener('touchend', onDragEnd, { once: true });
        document.addEventListener('touchcancel', onDragEnd, { once: true });
    };

    resizerEl.addEventListener('mousedown', onDragStart);
    resizerEl.addEventListener('touchstart', onDragStart, { passive: false }); // passive: false to allow preventDefault
}

/**
 * Sends a custom event to analytics services if they are loaded.
 * @param {string} eventName - The name of the event (e.g., 'view_changed', 'simulator_start').
 */
export function trackEvent(eventName) {
    // Hotjar Tracking
    if (typeof window.hj === 'function') {
        window.hj('event', eventName);
    }

    // Microsoft Clarity Tracking
    if (typeof window.clarity === 'function') {
        window.clarity('event', eventName);
    }
    
    // Log to console for debugging if no service is found
    if (typeof window.hj !== 'function' && typeof window.clarity !== 'function') {
        console.log(`[Analytics Event]: ${eventName}`);
    }
}