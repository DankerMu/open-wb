const dialogPrototype = HTMLDialogElement.prototype;

dialogPrototype.showModal = function showModal() {
  this.setAttribute("open", "");
};

dialogPrototype.close = function close() {
  this.removeAttribute("open");
};
