/* Run permissions and eligibility shared by dashboard and worker. */
(function(root) {
  const modes = {
    coords_address: {coords:true, details:true},
    coords_check: {coords:true, details:false},
    address_only: {coords:false, details:true}
  };
  function options(mode) {
    if (!Object.prototype.hasOwnProperty.call(modes, mode)) throw new Error('Choose a valid run option.');
    return {...modes[mode], mode};
  }
  function coordinateError(row) {
    const a=row.latitude, b=row.longitude;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 'Latitude and longitude must both be numbers.';
    if (a < -90 || a > 90 || b < -180 || b > 180) return 'Coordinates are out of range.';
    if (a < 6 || a > 38 || b < 67 || b > 98) return 'Coordinates are outside India (latitude/longitude swapped?).';
    return '';
  }
  // Submission state is independent of what Google currently displays.
  function detailsSubmitted(target) {
    return ['address','address2','address3','locality','admin','postal'].every(
      key=>['updated','ok','blank'].includes(target.detail?.[key]));
  }
  function needs(row, opts) {
    const eligible=!!row.store && !row.detailsReview && !row.sheetSkip && !['invalid','skipped','reviewed_skip','done_manual'].includes(row.status);
    return {
      coords:eligible && opts.coords && ['queued','error'].includes(row.status) && !coordinateError(row),
      details:eligible && opts.details && !row.detailsDone && !(row.targets?.filter(t=>!t.skip).length && row.targets.filter(t=>!t.skip).every(t=>t.detailsDone || detailsSubmitted(t)))
    };
  }
  root.RunPolicy={options, coordinateError, needs, detailsSubmitted};
  if(typeof module!=='undefined') module.exports=root.RunPolicy;
})(globalThis);
