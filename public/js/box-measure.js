(function(global){
  function sortedPair(a, b){
    return [Number(a) || 0, Number(b) || 0].sort(function(x, y){ return x - y; });
  }

  function judgeDimension(options){
    var wMm = Number(options && options.wMm) || 0;
    var hMm = Number(options && options.hMm) || 0;
    var cutW = Number(options && options.cutW) || 0;
    var cutH = Number(options && options.cutH) || 0;
    if(!cutW || !cutH) return { hasCut:false, wMm:wMm, hMm:hMm };

    var tolMm = Number(options && options.tolMm) || 10;
    var ratioTol = Number(options && options.ratioTol) || 0.08;
    var meas = sortedPair(wMm, hMm);
    var tgt = sortedPair(cutW, cutH);
    var dShort = Math.abs(meas[0] - tgt[0]);
    var dLong = Math.abs(meas[1] - tgt[1]);
    var okAbs = dShort <= tolMm && dLong <= tolMm;
    var measRatio = meas[1] / Math.max(meas[0], 1);
    var tgtRatio = tgt[1] / Math.max(tgt[0], 1);
    var okRatio = (Math.abs(measRatio - tgtRatio) / tgtRatio) <= ratioTol;
    var ok = okAbs || okRatio;

    return {
      hasCut:true,
      ok:ok,
      matchBy: okAbs ? '寸法' : (okRatio ? '比率' : ''),
      wMm:wMm,
      hMm:hMm,
      dShort:dShort,
      dLong:dLong
    };
  }

  function judgeRatioOnly(options){
    var cutW = Number(options && options.cutW) || 0;
    var cutH = Number(options && options.cutH) || 0;
    var measW = Number(options && options.measW) || 0;
    var measH = Number(options && options.measH) || 0;
    if(!cutW || !cutH || !measW || !measH) return { hasCut:false, ratioOnly:true };

    var ratioTol = Number(options && options.ratioTol) || 0.08;
    var meas = sortedPair(measW, measH);
    var tgt = sortedPair(cutW, cutH);
    var measRatio = meas[1] / Math.max(meas[0], 1);
    var tgtRatio = tgt[1] / Math.max(tgt[0], 1);
    var dev = Math.abs(measRatio - tgtRatio) / Math.max(tgtRatio, 0.0001);

    return {
      hasCut:true,
      ratioOnly:true,
      ok: dev <= ratioTol,
      matchBy:'比率',
      measRatio:measRatio,
      tgtRatio:tgtRatio,
      dev:dev
    };
  }

  global.BoxMeasure = {
    judgeDimension: judgeDimension,
    judgeRatioOnly: judgeRatioOnly
  };
})(window);
