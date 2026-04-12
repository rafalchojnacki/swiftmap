# Overview

The goal of this project is to build Visual Studio Code extension that will provide mind maps visual editor with automatic layout, and a dedicated text format to store these mind maps. Mind map look & feel should be minimalistic and optimized for fast edit experience. By mind map we mean here only tree-like structure displayed as a graph.

By mind map we mean here a graph of nodes. There is always exactly one root node. Each node can have zero or more child nodes.

# Functional Requirements

## Mind Map Visualization

Mind Map should be by default displayed in visual editor. Such editor should allow also do edit mind map, so a user don't have to edit text file. By default the mind map file should be opened in visual editor.

General features:

 - Mind map should be displayed as a graph
 - User should be able to move the whole view port using mouse or track pad
 - User should be able to zoom in and zoom out
 - Each node should have:
    - name
        - single-line text
        - no formatting
    - zero or more flags
        - possible flags: done (green check mark icon), rejected (red cross icon), question (blue question mark icon), task (purple square icon), idea (lamp icon), low priority, medium priority, or high priority
        - flag can be edited using ctrl+alt+N keyboard shortcut, where N is a number
    - can be in 'view' state or 'edit' state
        - at a time zero or one node can be in edit state
        - when in 'view' state, 'enter' or 'F2' key enters 'edit' state, when in 'edit' state 'enter' key confirms the update and 'esc' key rollbacks the changes
        - when a newly added node is in 'edit' state, 'esc' key aborts the creation and removes that node
        - 'edit' state allows to edit text in-line
 - New child node can be added using 'Shift + Enter' key combination
    - By default a new child node is in 'edit' mode
    - Newly added child node is added as the last node of the current one
    - When a new child node is added, it automatically receives focus in the editor
 - New sibling node can be added below the current node using 'Alt + Enter' key combination
    - Newly added sibling node is inserted directly after the current node in the list of its parent children
    - By default a new sibling node is in 'edit' mode
    - When a new sibling node is added, it automatically receives focus in the editor
    - Root node cannot have sibling nodes added this way
 - New sibling node can be added above the current node using 'Shift + Alt + Enter' key combination
    - Newly added sibling node is inserted directly before the current node in the list of its parent children
    - By default a new sibling node is in 'edit' mode
    - When a new sibling node is added, it automatically receives focus in the editor
    - Root node cannot have sibling nodes added this way
 - Can be expanded or collapsed
    - when collapsed, the child nodes are hidden, and there is a visual indicator showing that the node is collapsed
    - when expanded, the child nodes are visible
    - when in 'view' state, the 'Space' key changes between 'collapsed' and 'expanded' state
 - When a node is in 'view' state, 'Delete' key deletes the node. Root node cannot be deleted.
 - There should be undo/redo using 'Ctrl + Z' and 'Ctrl + Y' key combinations
 - It is possible to change the order of child nodes
    - 'Ctrl + up arrow' moves the node up in the list of its parent childs, 'Ctrl + down arrow' moves down
    - Reorder action changes only the order of siblings
    - If at the top/bottom, then it wraps
 - It is possible to move a single node or multiple selected nodes to another parent using drag-and-drop with mouse
    - Ctrl-clicking or Cmd-clicking nodes toggles multi-selection
    - Dragging a selected node and dropping it onto another node makes the selected node or selected nodes the last children of the target node
    - Root node cannot be moved
    - A node cannot be dropped onto itself or another selected node
    - A node cannot be dropped into its own subtree
    - Selected nodes cannot contain one another when moved together
 - Graph layout should be automatic - user cannot edit layout. Layout should be hierarchical and horizontal.
 - Arrow keys allow to navigate between nodes. It is also possible to use mouse to select a node.
 - Right-clicking a node should open a context menu with available actions, including edit, copy text, paste text, undo, redo, add child, add sibling above, add sibling below, expand/collapse, reorder, delete, and all flag toggles.
 - It should be possible to open the source of the current mind map file in a text editor from the visual editor
    - The visual editor should provide an icon action for this
 - It should be possible to open the visual editor for the current `.swiftmap` file from the text editor
    - The text editor should provide an icon action for this

## File Format

The graph should be stored as a text file. The formal `.swiftmap` file format specification lives in [SwiftMapFormat.md](SwiftMapFormat.md).

# Implementation Requirements

Visual Studio Code extension should be implemented using TypeScript.
