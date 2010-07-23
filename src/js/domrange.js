rangy.createModule("DomRange", function(api, module) {
    api.requireModules( ["DomUtil"] );

    var log = log4javascript.getLogger("rangy.DomRange");
    var dom = api.dom;
    var DomPosition = dom.DomPosition;

    function nodeToString(node) {
        if (!node) { return "No node"; }
        return dom.isCharacterDataNode(node) ? '"' + node.data + '"' : node.nodeName;
    }

    function getRangeDocument(range) {
        return dom.getDocument(range.startContainer);
    }

    function dispatchEvent(range, type, args) {
        for (var i = 0, len = range._listeners.length; i < len; ++i) {
            range._listeners[type][i].call(range, {target: range, args: args});
        }
    }

    // Updates commonAncestorContainer and collapsed after boundary change
    function updateCollapsedAndCommonAncestor(range) {
        range.collapsed = (range.startContainer === range.endContainer && range.startOffset === range.endOffset);
        range.commonAncestorContainer = range.collapsed ?
            range.startContainer : dom.getCommonAncestor(range.startContainer, range.endContainer);
    }

    function updateBoundaries(range, startContainer, startOffset, endContainer, endOffset) {
        var startMoved = (range.startContainer !== startContainer || range.startOffset !== startOffset);
        var endMoved = (range.endContainer !== endContainer || range.endOffset !== endOffset);

        range.startContainer = startContainer;
        range.startOffset = startOffset;
        range.endContainer = endContainer;
        range.endOffset = endOffset;

        updateCollapsedAndCommonAncestor(range);
        dispatchEvent(range, "boundarychange", {startMoved: startMoved, endMoved: endMoved});
    }

    function getBoundaryBeforeNode(node) {
        return new DomPosition(node.parentNode, dom.getNodeIndex(node));
    }

    function getBoundaryAfterNode(node) {
        return new DomPosition(node.parentNode, dom.getNodeIndex(node) + 1);
    }

    function getEndOffset(node) {
        return dom.isCharacterDataNode(node) ? node.length : (node.childNodes ? node.childNodes.length : 0);
    }

    function insertNodeAtPosition(node, n, o) {
        if (dom.isCharacterDataNode(n)) {
            if (o == n.length) {
                n.parentNode.appendChild(node);
            } else {
                n.parentNode.insertBefore(node, o == 0 ? n : dom.splitDataNode(n, o));
            }
        } else if (o >= n.childNodes.length) {
            n.appendChild(node);
        } else {
            n.insertBefore(node, n.childNodes[o]);
        }
        return node;
    }

    function cloneSubtree(iterator) {
        var partiallySelected;
        for (var node, frag = getRangeDocument(iterator.range).createDocumentFragment(), subIterator; node = iterator.next(); ) {
            partiallySelected = iterator.isPartiallySelectedSubtree();
            log.debug("cloneSubtree got node " + nodeToString(node) + " from iterator. partiallySelected: " + partiallySelected);
            node = node.cloneNode(!partiallySelected);
            if (partiallySelected) {
                subIterator = iterator.getSubtreeIterator();
                node.appendChild(cloneSubtree(subIterator));
                subIterator.detach(true);
            }

            if (node.nodeType == 10) { // DocumentType
                throw new DOMException("HIERARCHY_REQUEST_ERR");
            }
            frag.appendChild(node);
        }
        return frag;
    }

    function iterateSubtree(iterator, func) {
        var partiallySelected;
        for (var node, subIterator; node = iterator.next(); ) {
            partiallySelected = iterator.isPartiallySelectedSubtree();
            log.debug("iterateSubtree got node " + nodeToString(node) + " from iterator. partiallySelected: " + partiallySelected);
            func(node);
            subIterator = iterator.getSubtreeIterator();
            iterateSubtree(subIterator, func);
            subIterator.detach(true);
        }
    }

    function deleteSubtree(iterator) {
        var subIterator;
        while (iterator.next()) {
            if (iterator.isPartiallySelectedSubtree()) {
                subIterator = iterator.getSubtreeIterator();
                deleteSubtree(subIterator);
                subIterator.detach(true);
            } else {
                iterator.remove();
            }
        }
    }

    function extractSubtree(iterator) {
        log.debug("extract on iterator", iterator);
        for (var node, frag = getRangeDocument(iterator.range).createDocumentFragment(), subIterator; node = iterator.next(); ) {
            log.debug("extractSubtree got node " + nodeToString(node) + " from iterator. partiallySelected: " + iterator.isPartiallySelectedSubtree());

            if (iterator.isPartiallySelectedSubtree()) {
                node = node.cloneNode(false);
                subIterator = iterator.getSubtreeIterator();
                node.appendChild(extractSubtree(subIterator));
                subIterator.detach(true);
            } else {
                iterator.remove();
            }
            if (node.nodeType == 10) { // DocumentType
                throw new DOMException("HIERARCHY_REQUEST_ERR");
            }
            frag.appendChild(node);
        }
        return frag;
    }

    function createRangeContentRemover(remover) {
        return function() {
            assertNotDetached(this);

            var sc = this.startContainer, so = this.startOffset, root = this.commonAncestorContainer;

            var iterator = new RangeIterator(this);

            // Work out where to position the range after content removal
            var node, boundary;
            if (sc !== root) {
                node = dom.getClosestAncestorIn(sc, root, true);
                boundary = getBoundaryAfterNode(node);
                sc = boundary.node;
                so = boundary.offset;
            }

            // Check none of the range is read-only
            iterateSubtree(iterator, assertNodeNotReadOnly);

            iterator.reset();

            // Remove the content
            var returnValue = remover(iterator);
            iterator.detach();

            // Move to the new position
            updateBoundaries(this, sc, so, sc, so);

            return returnValue;
        };
    }

    function createBeforeAfterNodeSetter(isBefore, isStart) {
        return function(node) {
            assertNotDetached(this);
            assertValidNodeType(node, beforeAfterNodeTypes);
            assertValidNodeType(getRootContainer(node), rootContainerNodeTypes);

            var boundary = (isBefore ? getBoundaryBeforeNode : getBoundaryAfterNode)(node);
            (isStart ? setRangeStart : setRangeEnd)(this, boundary.node, boundary.offset);
        };
    }

    function isNonTextPartiallySelected(node, range) {
        return (node.nodeType != 3) &&
               (dom.isAncestorOf(node, range.startContainer, true) || dom.isAncestorOf(node, range.endContainer, true));
    }

    function setRangeStart(range, node, offset) {
        var ec = range.endContainer, eo = range.endOffset;
        if (node !== range.startContainer || offset !== this.startOffset) {
            // Check the root containers of the range and the new boundary, and also check whether the new boundary
            // is after the current end. In either case, collapse the range to the new position
            if (getRootContainer(node) != getRootContainer(ec) || dom.comparePoints(node, offset, ec, eo) == 1) {
                ec = node;
                eo = offset;
            }
            updateBoundaries(range, node, offset, ec, eo);
        }
    }

    function setRangeEnd(range, node, offset) {
        var sc = range.startContainer, so = range.startOffset;
        if (node !== range.endContainer || offset !== this.endOffset) {
            // Check the root containers of the range and the new boundary, and also check whether the new boundary
            // is after the current end. In either case, collapse the range to the new position
            if (getRootContainer(node) != getRootContainer(sc) || dom.comparePoints(node, offset, sc, so) == -1) {
                sc = node;
                so = offset;
            }
            updateBoundaries(range, sc, so, node, offset);
        }
    }

    var beforeAfterNodeTypes = [1, 3, 4, 5, 7, 8, 10];
    var rootContainerNodeTypes = [2, 9, 11];
    var readonlyNodeTypes = [5, 6, 10, 12];
    var insertableNodeTypes = [1, 3, 4, 5, 7, 8, 10, 11];
    var surroundNodeTypes = [1, 3, 4, 5, 7, 8];

    function createAncestorFinder(nodeTypes) {
        return function(node, selfIsAncestor) {
            var t, n = selfIsAncestor ? node : node.parentNode;
            while (n) {
                t = n.nodeType;
                if (dom.arrayContains(nodeTypes, t)) {
                    return n;
                }
                n = n.parentNode;
            }
            return null;
        };
    }

    function getRootContainer(node) {
        var parent;
        while ( (parent = node.parentNode) ) {
            node = parent;
        }
        return node;
    }

    var getDocumentOrFragmentContainer = createAncestorFinder( [9, 11] );
    var getReadonlyAncestor = createAncestorFinder(readonlyNodeTypes);
    var getDocTypeNotationEntityAncestor = createAncestorFinder( [6, 10, 12] );

    function assertNoDocTypeNotationEntityAncestor(node, allowSelf) {
        if (getDocTypeNotationEntityAncestor(node, allowSelf)) {
            throw new RangeException("INVALID_NODE_TYPE_ERR");
        }
    }

    function assertNotDetached(range) {
        if (range._detached) {
            throw new DOMException("INVALID_STATE_ERR");
        }
    }


    function assertValidNodeType(node, invalidTypes) {
        if (!dom.arrayContains(invalidTypes, node.nodeType)) {
            throw new RangeException("INVALID_NODE_TYPE_ERR");
        }
    }

    function assertValidOffset(node, offset) {
        if (offset < 0 || offset > (dom.isCharacterDataNode(node) ? node.length : node.childNodes.length)) {
            throw new DOMException("INDEX_SIZE_ERR");
        }
    }

    function assertSameDocumentOrFragment(node1, node2) {
        if (getDocumentOrFragmentContainer(node1, true) !== getDocumentOrFragmentContainer(node2, true)) {
            throw new DOMException("WRONG_DOCUMENT_ERR");
        }
    }

    function assertNodeNotReadOnly(node) {
        if (getReadonlyAncestor(node, true)) {
            throw new DOMException("NO_MODIFICATION_ALLOWED_ERR");
        }
    }

    function assertNode(node, codeName) {
        if (!node) {
            throw new DOMException(codeName);
        }
    }

    /*----------------------------------------------------------------------------------------------------------------*/

    // Exceptions

    var DOMExceptionCodes = {
        INDEX_SIZE_ERR: 1,
        HIERARCHY_REQUEST_ERR: 3,
        WRONG_DOCUMENT_ERR: 4,
        NO_MODIFICATION_ALLOWED_ERR: 7,
        NOT_FOUND_ERR: 8,
        NOT_SUPPORTED_ERR: 9,
        INVALID_STATE_ERR: 11
    };

    function DOMException(codeName) {
        this.code = DOMExceptionCodes[codeName];
        this.codeName = codeName;
        this.message = "DOMException: " + this.codeName;
    }

    DOMException.prototype = DOMExceptionCodes;

    DOMException.prototype.toString = function() {
        return this.message;
    };

    var RangeExceptionCodes = {
        BAD_BOUNDARYPOINTS_ERR: 1,
        INVALID_NODE_TYPE_ERR: 2
    };

    function RangeException(codeName) {
        this.code = RangeExceptionCodes[codeName];
        this.codeName = codeName;
        this.message = "RangeException: " + this.codeName;
    }

    RangeException.prototype = RangeExceptionCodes;

    RangeException.prototype.toString = function() {
        return this.message;
    };

    /*----------------------------------------------------------------------------------------------------------------*/

    function Range(doc) {
        this.startContainer = doc;
        this.startOffset = 0;
        this.endContainer = doc;
        this.endOffset = 0;
        this._listeners = {
            boundarychange: [],
            detach: []
        };
        updateCollapsedAndCommonAncestor(this);
    }

    var s2s = 0, s2e = 1, e2e = 2, e2s = 3;
    var rangeProperties = ["startContainer", "startOffset", "endContainer", "endOffset", "collapsed",
        "commonAncestorContainer"];
    var n_b = 0, n_a = 1, n_b_a = 2, n_i = 3;

    Range.START_TO_START = s2s;
    Range.START_TO_END = s2e;
    Range.END_TO_END = e2e;
    Range.END_TO_START = e2s;

    Range.NODE_BEFORE = n_b;
    Range.NODE_AFTER = n_a;
    Range.NODE_BEFORE_AND_AFTER = n_b_a;
    Range.NODE_INSIDE = n_i;

    /*
     TODO: Add getters/setters/object property attributes for startContainer etc that prevent setting and check for detachedness
      */

    Range.prototype = {
        START_TO_START: s2s,
        START_TO_END: s2e,
        END_TO_END: e2e,
        END_TO_START: e2s,

        NODE_BEFORE: n_b,
        NODE_AFTER: n_a,
        NODE_BEFORE_AND_AFTER: n_b_a,
        NODE_INSIDE: n_i,

        _detached: false,

        setStart: function(node, offset) {
            assertNotDetached(this);
            assertNoDocTypeNotationEntityAncestor(node, true);
            assertValidOffset(node, offset);

            setRangeStart(this, node, offset);
        },

        setEnd: function(node, offset) {
            assertNotDetached(this);
            assertNoDocTypeNotationEntityAncestor(node, true);
            assertValidOffset(node, offset);

            setRangeEnd(this, node, offset);
        },

        setStartBefore: createBeforeAfterNodeSetter(true, true),
        setStartAfter: createBeforeAfterNodeSetter(false, true),
        setEndBefore: createBeforeAfterNodeSetter(true, false),
        setEndAfter: createBeforeAfterNodeSetter(false, false),

        collapse: function(isStart) {
            assertNotDetached(this);
            if (isStart) {
                updateBoundaries(this, this.startContainer, this.startOffset, this.startContainer, this.startOffset);
            } else {
                updateBoundaries(this, this.endContainer, this.endOffset, this.endContainer, this.endOffset);
            }
        },

        selectNodeContents: function(node) {
            // This doesn't seem well specified: the spec talks only about selecting the node's contents, which
            // could be taken to mean only its children. However, browsers implement this the same as selectNode for
            // text nodes, so I shall do likewise
            assertNotDetached(this);
            assertNoDocTypeNotationEntityAncestor(node, true);

            updateBoundaries(this, node, 0, node, getEndOffset(node));
        },

        selectNode: function(node) {
            assertNotDetached(this);
            assertNoDocTypeNotationEntityAncestor(node, false);
            assertValidNodeType(node, beforeAfterNodeTypes);

            var start = getBoundaryBeforeNode(node), end = getBoundaryAfterNode(node);
            updateBoundaries(this, start.node, start.offset, end.node, end.offset);
        },

        compareBoundaryPoints: function(how, range) {
            assertNotDetached(this);
            assertSameDocumentOrFragment(this.startContainer, range.startContainer);

            var nodeA, offsetA, nodeB, offsetB;
            var prefixA = (how == e2s || how == s2s) ? "start" : "end";
            var prefixB = (how == s2e || how == s2s) ? "start" : "end";
            nodeA = this[prefixA + "Container"];
            offsetA = this[prefixA + "Offset"];
            nodeB = range[prefixB + "Container"];
            offsetB = range[prefixB + "Offset"];
            return dom.comparePoints(nodeA, offsetA, nodeB, offsetB);
        },

        insertNode: function(node) {
            assertNotDetached(this);
            assertValidNodeType(node, insertableNodeTypes);
            assertNodeNotReadOnly(this.startContainer);

            if (dom.isAncestorOf(node, this.startContainer, true)) {
                throw new DOMException("HIERARCHY_REQUEST_ERR");
            }

            // TODO: Add check for whether the container of the start of the Range is of a type that does not allow
            // children of the type of node

            insertNodeAtPosition(node, this.startContainer, this.startOffset);
            this.setStartBefore(node);
        },

        cloneContents: function() {
            assertNotDetached(this);

            var clone, frag;
            if (this.collapsed) {
                return getRangeDocument(this).createDocumentFragment();
            } else {
                if (this.startContainer === this.endContainer && dom.isCharacterDataNode(this.startContainer)) {
                    clone = this.startContainer.cloneNode(true);
                    clone.data = clone.data.slice(this.startOffset, this.endOffset);
                    frag = getRangeDocument(this).createDocumentFragment();
                    frag.appendChild(clone);
                    return frag;
                } else {
                    var iterator = new RangeIterator(this);
                    clone = cloneSubtree(iterator);
                    iterator.detach();
                }
                return clone;
            }
        },

        extractContents: createRangeContentRemover(extractSubtree),

        deleteContents: createRangeContentRemover(deleteSubtree),

        surroundContents: function(node) {
            // TODO: Check boundary containers are not readonly
            // TODO: Check start container allows children of the type of the node about to be added

            assertNotDetached(this);
            assertValidNodeType(node, surroundNodeTypes);

            // Check if the contents can be surrounded. Specifically, this means whether the range partially selects no
            // non-text nodes.
            var iterator = new RangeIterator(this);
            var boundariesInvalid = (iterator._first && (isNonTextPartiallySelected(iterator._first, this)) ||
                    (iterator._last && isNonTextPartiallySelected(iterator._last, this)));
            iterator.detach();
            if (boundariesInvalid) {
                throw new RangeException("BAD_BOUNDARYPOINTS_ERR");
            }

            // Extract the contents
            var content = this.extractContents();

            // Clear the children of the node
            if (node.hasChildNodes()) {
                while (node.lastChild) {
                    node.removeChild(node.lastChild);
                }
            }

            // Insert the new node and add the extracted contents
            insertNodeAtPosition(node, this.startContainer, this.startOffset);
            node.appendChild(content);

            this.selectNode(node);
        },

        cloneRange: function() {
            assertNotDetached(this);
            var range = new Range(getRangeDocument(this));
            var i = rangeProperties.length, prop;
            while (i--) {
                prop = rangeProperties[i];
                range[prop] = this[prop];
            }
            return range;
        },

        detach: function() {
            assertNotDetached(this);
            this._detached = true;
            this.startContainer = this.startOffset = this.endContainer = this.endOffset = null;
            this.collapsed = this.commonAncestorContainer = null;
            dispatchEvent(this, "detach", null);
        },

        toString: function() {
            assertNotDetached(this);
            var sc = this.startContainer;
            if (sc === this.endContainer && dom.isCharacterDataNode(sc)) {
                return (sc.nodeType == 3 || sc.nodeType == 4) ? sc.data.slice(this.startOffset, this.endOffset) : "";
            } else {
                var textBits = [], iterator = new RangeIterator(this);
                log.info("toString iterator: " + nodeToString(iterator._first) + ", " + nodeToString(iterator._last));
                iterateSubtree(iterator, function(node) {
                    // Accept only text or CDATA nodes
                    log.info("toString: got node", nodeToString(node));
                    if (node.nodeType == 2) {
                        log.info("Got attr: ", node);
                    }
                    if (node.nodeType == 3 || node.nodeType == 4) {
                        textBits.push(node.data);
                    }
                });
                iterator.detach();
                return textBits.join("");
            }
        },

        // The methods below are all non-standard. The following batch were introduced by Mozilla but have since been
        // removed.

        compareNode: function(node) {
            assertNotDetached(this);

            var parent = node.parentNode;
            var nodeIndex = dom.getNodeIndex(node);

            if (!parent) {
                throw new DOMException("NOT_FOUND_ERR");
            }

            var startComparison = this.comparePoint(parent, nodeIndex),
                endComparison = this.comparePoint(parent, nodeIndex + 1);

            if (startComparison < 0) { // Node starts before
                return (endComparison > 0) ? n_b_a : n_b;
            } else {
                return (endComparison > 0) ? n_a : n_i;
            }
        },

        comparePoint: function(node, offset) {
            assertNotDetached(this);
            assertNode(node, "HIERARCHY_REQUEST_ERR");
            assertSameDocumentOrFragment(node, this.startContainer);

            if (dom.comparePoints(node, offset, this.startContainer, this.startOffset) < 0) {
                return -1;
            } else if (dom.comparePoints(node, offset, this.endContainer, this.endOffset) > 0) {
                return 1;
            }
            return 0;
        },

        createContextualFragment: function(html) {
            assertNotDetached(this);
            var sc = this.startContainer, el = (sc.nodeType == 1) ? sc : sc.parentNode;
            assertNode(el, "NOT_SUPPORTED_ERR");

            var container = el.cloneNode(false);

            // This is obviously non-standard but will work in all recent browsers
            container.innerHTML = html;
            var frag = dom.getDocument(el).createDocumentFragment(), n;
            while ( (n = el.firstChild) ) {
                frag.appendChild(n);
            }

            return frag;
        },

        intersectsNode: function(node) {
            assertNotDetached(this);
            assertNode(node, "NOT_FOUND_ERR");
            if (dom.getDocument(node) != getRangeDocument(this)) {
                return false;
            }

            var parent = node.parentNode, offset = dom.getNodeIndex(node);
            assertNode(node, "NOT_FOUND_ERR");

            var startComparison = dom.comparePoints(parent, offset, this.startContainer, this.startOffset),
                endComparison = dom.comparePoints(parent, offset + 1, this.endContainer, this.endOffset);

            return !((startComparison < 0 && endComparison < 0) || (startComparison > 0 && endComparison > 0));
        },

        isPointInRange: function(node, offset) {
            assertNotDetached(this);
            assertNode(node, "HIERARCHY_REQUEST_ERR");
            assertSameDocumentOrFragment(node, this.startContainer);

            return (dom.comparePoints(node, offset, this.startContainer, this.startOffset) >= 0) &&
                   (dom.comparePoints(node, offset, this.endContainer, this.endOffset) <= 0);
        },

        // The methods below are non-standard and invented by me.
        intersectsRange: function(range) {
            assertNotDetached(this);

            if (getRangeDocument(range) != getRangeDocument(this)) {
                throw new DOMException("WRONG_DOCUMENT_ERR");
            }

            return dom.comparePoints(this.startContainer, this.startOffset, range.endContainer, range.endOffset) < 0 &&
                   dom.comparePoints(this.endContainer, this.endOffset, range.startContainer, range.startOffset) > 0;
        },

        createIterator: function(filter, splitEnds) {
            // TODO: Implement

        },

        splitEnds: function() {
            var sc = this.startContainer, so = this.startOffset, ec = this.endContainer, eo = this.endOffset;
            assertNotDetached(this);

            if (dom.isCharacterDataNode(sc)) {
                sc = dom.splitDataNode(sc, so);
                so = 0;
            }
            if (dom.isCharacterDataNode(ec)) {
                dom.splitDataNode(ec, eo);
            }
            updateBoundaries(this, sc, so, ec, eo);
        },

        getNodes: function(filter, splitEnds) {
            // TODO: Implement
            var nodes = [], iterator = new RangeIterator(this);
            iterateSubtree(iterator, function(node) {
                if (!filter || filter(node)) {
                    nodes.push(node);
                }
            });
            iterator.detach();
            return nodes;
        }
    };



/*
    function() {
        function createGetter(propName) {
            return function() {
                if (this._detached) {
                    throw new DOMException("INVALID_STATE_ERR");
                }
                return this["_" + propName];
            }
        }

        function setter() {
            throw new Error("This property is read-only");
        }


        var i = rangeProperties.length;
        if (typeof Object.defineProperty == "function") {
            // ECMAScript 5
            while (i--) {
                Object.defineProperty(Range.prototype, rangeProperties[i], {
                    get: createGetter(rangeProperties[i])
                });
            }
        } else if (Range.prototype.__defineGetter__ && Range.prototype.__defineSetter__) {
            while (i--) {
                Range.prototype.__defineGetter__(rangeProperties[i], createGetter(rangeProperties[i]));
                Range.prototype.__defineSetter__(rangeProperties[i], setter);
            }
        }
    }
*/



    /*----------------------------------------------------------------------------------------------------------------*/


    // RangeIterator code indebted to IERange by Tim Ryan (http://github.com/timcameronryan/IERange)

    function RangeIterator(range) {
        this.range = range;

        log.info("New RangeIterator ", nodeToString(range.startContainer), range.startOffset, nodeToString(range.endContainer), range.endOffset);

        if (!range.collapsed) {
            this.sc = range.startContainer;
            this.so = range.startOffset;
            this.ec = range.endContainer;
            this.eo = range.endOffset;
            var root = range.commonAncestorContainer;

            if (this.sc === this.ec && dom.isCharacterDataNode(this.sc)) {
                this.isSingleCharacterDataNode = true;
                this._first = this._last = this.sc;
            } else {
                this._first = this._next = (this.sc === root && !dom.isCharacterDataNode(this.sc)) ?
                    this.sc.childNodes[this.so] : dom.getClosestAncestorIn(this.sc, root, true);
                this._last = (this.ec === root && !dom.isCharacterDataNode(this.ec)) ?
                    this.ec.childNodes[this.eo - 1] : dom.getClosestAncestorIn(this.ec, root, true);
            }
            log.info("RangeIterator first and last", nodeToString(this._first), nodeToString(this._last));
        }
    }

    RangeIterator.prototype = {
        _current: null,
        _next: null,
        _first: null,
        _last: null,
        isSingleCharacterDataNode: false,

        reset: function() {
            this._current = null;
            this._next = this._first;
        },

        hasNext: function() {
            return !!this._next;
        },

        next: function() {
            // Move to next node
            var current = this._current = this._next;
            if (current) {
                this._next = (current !== this._last) ? current.nextSibling : null;

                // Check for partially selected text nodes
                if (dom.isCharacterDataNode(current)) {
                    if (current === this.ec) {
                        (current = current.cloneNode(true)).deleteData(this.eo, current.length - this.eo);
                    }
                    if (this._current === this.sc) {
                        (current = current.cloneNode(true)).deleteData(0, this.so);
                    }
                }
            }

            return current;
        },

        remove: function() {
            var current = this._current, start, end;

            if (dom.isCharacterDataNode(current) && (current === this.sc || current === this.ec)) {
                start = (current === this.sc) ? this.so : 0;
                end = (current === this.ec) ? this.eo : current.length;
                if (start != end) {
                    current.deleteData(start, end - start);
                }
            } else {
                current.parentNode.removeChild(current);
            }
        },

        // Checks if the current node is partially selected
        isPartiallySelectedSubtree: function() {
            var current = this._current;
            return isNonTextPartiallySelected(current, this.range);
        },

        getSubtreeIterator: function() {
            var subRange;
            if (this.isSingleCharacterDataNode) {
                subRange = this.range.cloneRange();
                subRange.collapse();
            } else {
                subRange = new Range(getRangeDocument(this.range));
                var current = this._current;
                var startContainer = current, startOffset = 0, endContainer = current, endOffset = getEndOffset(current);

                if (dom.isAncestorOf(current, this.sc, true)) {
                    startContainer = this.sc;
                    startOffset = this.so;
                }
                if (dom.isAncestorOf(current, this.ec, true)) {
                    endContainer = this.ec;
                    endOffset = this.eo;
                }

                updateBoundaries(subRange, startContainer, startOffset, endContainer, endOffset);
            }
            return new RangeIterator(subRange);
        },

        detach: function(detachRange) {
            if (detachRange) {
                this.range.detach();
            }
            this.range = this._current = this._next = this._first = this._last = this.sc = this.so = this.ec = this.eo = null;
        }
    };

    Range.RangeIterator = RangeIterator;
    Range.DOMException = DOMException;
    Range.RangeException = RangeException;

    Range.util = {
        getRangeDocument: getRangeDocument
    };

    rangy.DomRange = Range;
});